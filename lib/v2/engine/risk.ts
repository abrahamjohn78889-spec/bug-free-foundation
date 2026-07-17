// ============================================================================
// RISK MANAGER — the single mandatory gate in front of EVERY order placement
// ============================================================================
// Both order-producing paths (registry strategy quote/reprice and the
// Standing Limit Order trigger) MUST pass checkOrder() before calling
// executor.placeOrder(). The gate enforces:
//
//   1. KILL SWITCH        — operator- or breaker-engaged hard stop, persisted
//                           in the DB so it survives restarts. Nothing trades
//                           until it is explicitly disengaged.
//   2. DAILY LOSS LIMIT   — realized PnL for the current UTC day; a breach
//                           auto-engages the kill switch (circuit breaker).
//   3. ORDER NOTIONAL CAP — no single order may exceed the configured USD cap.
//   4. DAILY ORDER CAP    — bounds total daily submissions (runaway-loop guard).
//   5. PRICE SANITY       — price must be inside [0.01, 0.99] and tick-aligned.
//   6. SHARE SANITY       — integer shares within [1, maxSharesPerOrder].
//   7. EXPIRY GUARD       — no new orders for an already-expired slot.
//
// All limits are kv-persisted and adjustable at runtime via the control API.
// ============================================================================

import { dailyOrderSubmissions, dailyRiskStats, kvGet, kvSet } from "./db"
import { logEvent } from "./events"
import { notify } from "./notifier"
import type { PipelineMode } from "./types"

export interface RiskLimits {
  /** Hard stop on realized loss per UTC day (positive number, USD). */
  maxDailyLossUsd: number
  /** Max notional (price x shares) for a single order, USD. */
  maxOrderNotionalUsd: number
  /** Max order submissions per UTC day (runaway-loop guard). */
  maxDailyOrders: number
  /** Max shares in a single order. */
  maxSharesPerOrder: number
}

export interface KillSwitchState {
  engaged: boolean
  reason: string
  atMs: number
  /** "OPERATOR" (manual) or "BREAKER" (auto, e.g. daily loss breach). */
  source: "OPERATOR" | "BREAKER" | ""
}

export interface RiskSnapshot {
  killSwitch: KillSwitchState
  limits: RiskLimits
  dailyRealizedPnl: number
  dailySettledTrades: number
  dailyOrdersSubmitted: number
}

export type RiskVerdict = { ok: true } | { ok: false; reason: string }

// maxDailyOrders is a RUNAWAY-LOOP guard, not a business limit. It must be
// comfortably above what legitimate continuous trading can produce: the SLO
// alone submits up to 288 orders/day (one per 5-minute window), plus placement
// retries and the strategy path's cancel-replace churn. The previous default
// of 300 was silently reached within a single day of healthy trading, vetoing
// every further order until UTC midnight — the engine looked armed but never
// traded again. 2000/day still trips instantly on a genuine runaway loop
// (which produces hundreds of submissions per MINUTE), without ever halting
// legitimate one-per-window execution.
const DEFAULT_LIMITS: RiskLimits = {
  maxDailyLossUsd: 100,
  maxOrderNotionalUsd: 500,
  maxDailyOrders: 2000,
  maxSharesPerOrder: 1000,
}

const KV_LIMITS = "risk:limits"
const KV_KILL = "risk:killswitch"
const KV_ORDER_CAP_MIGRATION = "risk:migration:daily-order-cap-2000"

export class RiskManager {
  private mode: () => PipelineMode
  private limits: RiskLimits
  private kill: KillSwitchState

  constructor(getMode: () => PipelineMode) {
    this.mode = getMode
    this.limits = this.loadLimits()
    this.kill = this.loadKill()
    // One-time migration: sessions that persisted the OLD default daily order
    // cap (300) inherit the new default (2000). 300 was reachable within one
    // day of healthy one-per-window trading and silently halted the engine
    // until UTC midnight. An operator-tuned custom value is left untouched.
    try {
      if (kvGet(KV_ORDER_CAP_MIGRATION) !== "1") {
        if (this.limits.maxDailyOrders === 300) {
          this.limits.maxDailyOrders = DEFAULT_LIMITS.maxDailyOrders
          kvSet(KV_LIMITS, JSON.stringify(this.limits))
          logEvent(
            "warn",
            `[RISK] daily order cap migrated 300 → ${DEFAULT_LIMITS.maxDailyOrders}: the old default was reachable by legitimate continuous trading and silently blocked all orders for the rest of the UTC day`,
          )
        }
        kvSet(KV_ORDER_CAP_MIGRATION, "1")
      }
    } catch {
      /* migration must never block boot */
    }
    if (this.kill.engaged) {
      logEvent("warn", `[RISK] Kill switch is ENGAGED from a previous session (${this.kill.source}: ${this.kill.reason}) — trading blocked until disengaged`)
    }
  }

  // ---------- persistence ----------

  private loadLimits(): RiskLimits {
    try {
      const raw = kvGet(KV_LIMITS)
      if (!raw) return { ...DEFAULT_LIMITS }
      const p = JSON.parse(raw) as Partial<RiskLimits>
      return {
        maxDailyLossUsd: this.posOr(p.maxDailyLossUsd, DEFAULT_LIMITS.maxDailyLossUsd),
        maxOrderNotionalUsd: this.posOr(p.maxOrderNotionalUsd, DEFAULT_LIMITS.maxOrderNotionalUsd),
        maxDailyOrders: this.posOr(p.maxDailyOrders, DEFAULT_LIMITS.maxDailyOrders),
        maxSharesPerOrder: this.posOr(p.maxSharesPerOrder, DEFAULT_LIMITS.maxSharesPerOrder),
      }
    } catch {
      return { ...DEFAULT_LIMITS }
    }
  }

  private loadKill(): KillSwitchState {
    try {
      const raw = kvGet(KV_KILL)
      if (!raw) return { engaged: false, reason: "", atMs: 0, source: "" }
      const p = JSON.parse(raw) as Partial<KillSwitchState>
      return {
        engaged: p.engaged === true,
        reason: typeof p.reason === "string" ? p.reason : "",
        atMs: typeof p.atMs === "number" ? p.atMs : 0,
        source: p.source === "OPERATOR" || p.source === "BREAKER" ? p.source : "",
      }
    } catch {
      return { engaged: false, reason: "", atMs: 0, source: "" }
    }
  }

  private posOr(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback
  }

  // ---------- kill switch ----------

  engageKillSwitch(reason: string, source: "OPERATOR" | "BREAKER"): void {
    this.kill = { engaged: true, reason, atMs: Date.now(), source }
    kvSet(KV_KILL, JSON.stringify(this.kill))
    logEvent("error", `[RISK] KILL SWITCH ENGAGED (${source}): ${reason} — all order placement blocked`, "risk")
    notify("risk", "KILL SWITCH ENGAGED", `Source: ${source}\nReason: ${reason}\nAll order placement is blocked`)
  }

  disengageKillSwitch(): void {
    const was = this.kill
    this.kill = { engaged: false, reason: "", atMs: 0, source: "" }
    kvSet(KV_KILL, JSON.stringify(this.kill))
    logEvent("warn", `[RISK] Kill switch disengaged (was: ${was.source}: ${was.reason || "n/a"}) — trading re-enabled`)
  }

  get killSwitch(): KillSwitchState {
    return { ...this.kill }
  }

  // ---------- limits ----------

  setLimits(next: Partial<RiskLimits>): RiskLimits {
    this.limits = {
      maxDailyLossUsd: this.posOr(next.maxDailyLossUsd, this.limits.maxDailyLossUsd),
      maxOrderNotionalUsd: this.posOr(next.maxOrderNotionalUsd, this.limits.maxOrderNotionalUsd),
      maxDailyOrders: this.posOr(next.maxDailyOrders, this.limits.maxDailyOrders),
      maxSharesPerOrder: this.posOr(next.maxSharesPerOrder, this.limits.maxSharesPerOrder),
    }
    kvSet(KV_LIMITS, JSON.stringify(this.limits))
    logEvent("info", `[RISK] Limits updated: dailyLoss $${this.limits.maxDailyLossUsd}, orderNotional $${this.limits.maxOrderNotionalUsd}, dailyOrders ${this.limits.maxDailyOrders}, maxShares ${this.limits.maxSharesPerOrder}`)
    return { ...this.limits }
  }

  getLimits(): RiskLimits {
    return { ...this.limits }
  }

  // ---------- the mandatory pre-order gate ----------

  /**
   * Validate a prospective order. Called by BOTH order-producing paths
   * immediately before executor.placeOrder(). Returns a verdict; a daily
   * loss breach additionally auto-engages the kill switch.
   */
  checkOrder(req: { price: number; shares: number; slotEndMs: number; tickSize?: number }): RiskVerdict {
    // 1. Kill switch
    if (this.kill.engaged) {
      return { ok: false, reason: `kill switch engaged (${this.kill.source}: ${this.kill.reason})` }
    }

    // 5. Price sanity
    if (!Number.isFinite(req.price) || req.price < 0.01 || req.price > 0.99) {
      return { ok: false, reason: `price $${req.price} outside sane band [0.01, 0.99]` }
    }
    const tick = req.tickSize && req.tickSize > 0 ? req.tickSize : 0.01
    const remainder = Math.abs(req.price / tick - Math.round(req.price / tick))
    if (remainder > 1e-6) {
      return { ok: false, reason: `price $${req.price} not aligned to tick ${tick}` }
    }

    // 6. Share sanity
    if (!Number.isInteger(req.shares) || req.shares < 1) {
      return { ok: false, reason: `shares ${req.shares} must be a positive integer` }
    }
    if (req.shares > this.limits.maxSharesPerOrder) {
      return { ok: false, reason: `shares ${req.shares} exceeds max ${this.limits.maxSharesPerOrder}` }
    }

    // 3. Notional cap
    const notional = req.price * req.shares
    if (notional > this.limits.maxOrderNotionalUsd) {
      return { ok: false, reason: `notional $${notional.toFixed(2)} exceeds cap $${this.limits.maxOrderNotionalUsd}` }
    }

    // 7. Expiry guard — refuse orders into an expired slot AND orders placed
    // so close to settlement that they cannot realistically rest/fill (the
    // placement round-trip alone eats most of the remaining time).
    const MIN_TIME_TO_EXPIRY_MS = 3_000
    if (req.slotEndMs > 0 && Date.now() >= req.slotEndMs - MIN_TIME_TO_EXPIRY_MS) {
      return {
        ok: false,
        reason:
          Date.now() >= req.slotEndMs
            ? "slot already expired — refusing to place an order into a settled market"
            : `less than ${MIN_TIME_TO_EXPIRY_MS / 1000}s to slot expiry — too late to place a new order`,
      }
    }

    // 2 + 4. Daily counters (SQLite reads, sub-ms)
    try {
      const mode = this.mode()
      const daily = dailyRiskStats(mode)
      if (daily.realizedPnl <= -this.limits.maxDailyLossUsd) {
        this.engageKillSwitch(
          `daily loss limit breached: realized $${daily.realizedPnl.toFixed(2)} <= -$${this.limits.maxDailyLossUsd}`,
          "BREAKER",
        )
        return { ok: false, reason: `daily loss limit breached ($${daily.realizedPnl.toFixed(2)})` }
      }
      const submitted = dailyOrderSubmissions(mode)
      if (submitted >= this.limits.maxDailyOrders) {
        return { ok: false, reason: `daily order cap reached (${submitted}/${this.limits.maxDailyOrders})` }
      }
    } catch (e) {
      // A risk-DB read failure must FAIL CLOSED for live money.
      const msg = e instanceof Error ? e.message : String(e)
      logEvent("error", `[RISK] risk stats query failed (${msg}) — failing closed, order blocked`)
      return { ok: false, reason: `risk stats unavailable (${msg}) — failing closed` }
    }

    return { ok: true }
  }

  // ---------- dashboard snapshot ----------

  snapshot(): RiskSnapshot {
    let pnl = 0
    let settled = 0
    let submitted = 0
    try {
      const daily = dailyRiskStats(this.mode())
      pnl = daily.realizedPnl
      settled = daily.settledTrades
      submitted = dailyOrderSubmissions(this.mode())
    } catch {
      /* snapshot must never throw */
    }
    return {
      killSwitch: this.killSwitch,
      limits: this.getLimits(),
      dailyRealizedPnl: Math.round(pnl * 100) / 100,
      dailySettledTrades: settled,
      dailyOrdersSubmitted: submitted,
    }
  }
}
