import { randomUUID } from "node:crypto"
import { currentSlotEndMs, nowMs, marketIdForSlot, tMinusMs } from "./clock"
import { insertOrderLog, insertTrade, kvGet, kvSet, openTrade, settleTrade, updateOpenTradeMark, updateSettledBalance } from "./db"
import { logEvent } from "./events"
import { notify } from "./notifier"
import { startSettlementVerifier, verifySettlements } from "./settlement-verifier"
import { PaperExecutor } from "./execution/paper"
import type { Executor } from "./execution/executor"
import type { MarketDiscovery, DiscoveredMarket } from "./feeds/market-discovery"
import type { ClobPriceFeed, FeedSnapshot } from "./feeds/clob-price-feed"
import type { BtcReferenceFeed } from "./feeds/btc-reference-feed"
import type { Bankroll } from "./bankroll"
import type { RiskManager } from "./risk"
import type {
  OpenOrder,
  PipelineMode,
  SloSizingMode,
  StandingLimitOrder,
  StandingOrderStatus,
  TradeSide,
  TriggerMode,
} from "./types"

// ------------------------------------------------------------
// StandingOrderManager — majority-side trigger, direction-locked,
// one-shot-per-window engine.
//
// Execution model:
//   • The user sets a Target Limit Price and a Trigger Price (≤ target).
//   • MAJORITY SIDE ONLY: on each NEW 5-minute market the engine derives the
//     current candle direction from the fresh BTC reference price versus the
//     captured candle strike. It monitors ONLY that majority side for the
//     trigger. Opposite-side trigger touches are ignored.
//   • DIRECTION LOCK: once a side is locked the engine ONLY ever looks at that
//     side and ignores the opposite contract completely. The lock resets only
//     when a new 5-minute market begins.
//   • ONE ORDER PER WINDOW: the engine submits a single LIMIT BUY at the
//     target on the locked side. After that order fills, the engine is done
//     for the window — it places no further orders and simply holds the
//     position (marks + PnL kept live) until the slot rolls over.
//   • Trigger fires immediately when the live price is at/above the trigger
//     (AT_OR_ABOVE, the default), including firing right away at arm/boot if
//     already there. UPWARD_CROSSING (fresh-crossing) is still available.
//   • Min/Max guardrails suppress operation outside the band.
//   • One resting order at a time. All open lots are settled together at
//     market resolution (early via Gamma `closed` detection, or at the
//     5-minute clock boundary).
//
// Runs on its OWN 1-second loop, sharing NO state with the strategy
// engine's tick loop, Time Window / phase machine, or open order.
// ------------------------------------------------------------

/**
 * Latency breakdown for ONE order submission, measured on the execution hot
 * path (quote → snapshot → decision → lock → submit → ack → immediate fill).
 * All values are ms. Exposed in the SLO snapshot and stored in the trade's
 * feedAudit so execution speed is permanently auditable per trade.
 */
export interface SloExecutionLatency {
  /** Age of the freshest quote in the deciding snapshot when it was captured. */
  quoteAgeMs: number
  /** Snapshot capture → trigger decision (lock taken). */
  decisionMs: number
  /** Trigger decision → placeOrder() call start (risk gate + persist). */
  preSubmitMs: number
  /** placeOrder() call start → exchange ack (order id returned). */
  submitMs: number
  /** Exchange ack → immediate fill check result. */
  fillCheckMs: number
  /** Snapshot capture → exchange ack (total engine-side execution time). */
  totalMs: number
  /** Epoch ms of the submission (when placeOrder was called). */
  atMs: number
}

const LOOP_MS = 1_000
/** Fast cadence when execution timing matters: inside the entry window, within
 *  5s of window open, or within the final 60s of the slot. 250ms gives ≥20
 *  evaluations in a 5s window even with zero WS pushes (vs ~5 at 1s). */
const HOT_LOOP_MS = 250
/** "Near the window" horizon: switch to the hot cadence this many ms before
 *  the entry window opens, so the first in-window tick is never late. */
const WINDOW_APPROACH_MS = 5_000
/** Always run hot in the final stretch of the slot regardless of window
 *  configuration — this is where fills, early resolution, and settlement
 *  detection are time-critical. */
const SLOT_FINAL_HOT_MS = 60_000
const SPOT_STALE_MS = 10_000
const TICK = 0.01
/** If a tick has been "busy" longer than this, its promise is a ghost (a hung
 *  network call) — the flag is force-cleared so the engine can never silently
 *  stall for the rest of the process lifetime. Mirrors the main engine loop's
 *  deadlock guard. */
const BUSY_STUCK_MS = 15_000
/** Hard ceiling on any single exchange REST call awaited inside the tick.
 *  The Polymarket SDK has no built-in timeout, so a half-open TCP connection
 *  would otherwise hang the await forever (the REST twin of the zombie-WS
 *  failure mode the watchdog repairs). */
const EXEC_CALL_TIMEOUT_MS = 15_000

/** Reject a promise that does not settle within `ms`, so no exchange call can
 *  wedge the tick loop. The underlying request is abandoned (the SDK offers no
 *  abort); the tick's error/ambiguity handling owns recovery from there. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${(ms / 1000).toFixed(0)}s`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

// --- Settlement resolution (single source of truth = official Polymarket) ---
// The official Chainlink-resolved outcome is polled with backoff before ANY
// win/loss is committed, in BOTH paper and live modes. Settling from a LOCAL
// spot heuristic (the previous behavior) produced intermittent "won-but-booked-
// as-loss" mismatches whenever the spot tick was stale/zero or the candle was
// near-the-money.
// 40 × 3s = 120s of patience. Gamma publishes the official result 15–90s after
// the candle closes; the old 60s window regularly LOST the race and forced a
// spot-fallback settle that the verifier later flagged as a mismatch (Phase 4
// audit finding #4). Waiting up to 120s means the authoritative result wins in
// virtually every slot; fallback/SCRATCH become the rare exception — and both
// are now auto-repaired by the verifier if the official result appears later.
const RESOLUTION_ATTEMPTS = 40
const RESOLUTION_POLL_MS = 3_000
// A spot tick may back a FALLBACK winner only when it clears the strike by at
// least this decisive margin (and is fresh per SPOT_STALE_MS). Anything closer
// is treated as unverifiable and settled SCRATCH rather than guessed.
// FORENSIC NOTE (trade ecac0be7): $1 was far inside the noise band between our
// spot feed and the official Chainlink data-stream round Polymarket resolves
// against — the fallback picked UP on a candle Chainlink resolved DOWN, booking
// a winning trade as a $10.89 loss. $20 demands a genuinely decisive move.
const FALLBACK_MIN_MARGIN_USD = 20

interface Params {
  limitPrice: number
  triggerPrice: number
  minPrice: number
  maxPrice: number
  /** FIXED_SHARES: the exact share count. Other modes: legacy fallback only. */
  shares: number
  triggerMode: TriggerMode
  /** Position sizing model. FIXED_SHARES preserves the legacy behavior. */
  sizingMode: SloSizingMode
  /** Meaning per mode: share count | dollar amount | percent of pool (1–100). */
  sizeValue: number
  /**
   * FINAL ENTRY WINDOW in ms measured backwards from SETTLEMENT, or null =
   * disabled. The trigger may only fire while (slotEndMs − now) ≤
   * entryWindowMs — i.e. during the LAST N seconds of the market, closing at
   * settlement. Before the window opens the order monitors live prices but
   * NEVER places, and NEVER remembers pre-window trigger touches. Re-opens
   * automatically each market via rollover. Measured with the drift-corrected
   * synced clock (nowMs), never the raw wall clock.
   */
  entryWindowMs: number | null
}

/** Valid entry-window durations (seconds) accepted from the API/UI. */
export const SLO_WINDOW_OPTIONS_SEC = [5, 15, 30, 45, 60, 90, 120] as const

// Immediate at-or-above is the default: the order fires the moment the live
// best-ask meets or exceeds the trigger, including firing right away at arm/boot
// if the price is already there. (UPWARD_CROSSING remains available for callers
// that explicitly want fresh-crossing semantics.)
const DEFAULT_TRIGGER_MODE: TriggerMode = "AT_OR_ABOVE"

interface Deps {
  getMode: () => PipelineMode
  getBankroll: () => Bankroll
  discovery: MarketDiscovery
  clobPriceFeed: ClobPriceFeed
  /** BTC reference feed — used ONLY for paper-mode candle settlement, never for
   *  trigger detection, majority side, or execution (those are CLOB-only). */
  spotFeed: BtcReferenceFeed
  /** Mandatory pre-order risk gate (kill switch, loss limits, sanity checks). */
  risk: RiskManager
}

interface FilledLot {
  side: TradeSide
  price: number
  shares: number
  cost: number
  marketId: string
  slotEndMs: number
  /** Ledger row id opened on fill; settled in place at resolution. */
  tradeId: number | null
  /** Exchange order id for this fill. */
  orderId: string | null
  /** Unique execution id. */
  tradeUid: string
  /** Epoch ms the fill was confirmed. */
  filledAtMs: number
}

export class StandingOrderManager {
  private deps: Deps

  private params: Params | null = null
  private paused = false
  private status: StandingOrderStatus = "ARMED"
  private executionCount = 0
  private lastExecutedAtMs: number | null = null

  private executor: Executor | null = null
  /** Self-scheduling timer chain (replaces the fixed setInterval): each tick
   *  schedules the next at an adaptive delay (HOT_LOOP_MS near/inside the
   *  entry window and the final slot stretch, LOOP_MS otherwise). */
  private loop: ReturnType<typeof setTimeout> | null = null
  /** Precise one-shot timer armed while WINDOW_WAITING that fires a tick at
   *  the exact window-open instant, eliminating timer-phase lateness. */
  private windowOpenTimer: ReturnType<typeof setTimeout> | null = null
  private busy = false
  /** Epoch ms the in-flight tick started — drives the busy-deadlock guard. */
  private lastTickStartMs = 0
  /** Epoch ms the last tick COMPLETED (reached finally) — liveness signal for
   *  the SLO watchdog. */
  private lastTickCompletedMs = 0
  /**
   * TICK EPOCH — ghost-tick abandonment. Incremented whenever the world a
   * running tick captured may no longer be valid: busy-watchdog fire, slot
   * rollover, cancel/dispose/pause, watchdog kick. Every await inside tick()
   * re-checks its captured epoch afterwards; on mismatch the tick ABANDONS
   * immediately with zero further state writes. This closes the
   * duplicate-execution / corrupted-state hole where a hung network call
   * resumed a "ghost" tick after the busy-watchdog had already let a new
   * tick run concurrently.
   */
  private tickEpoch = 0
  /** Single-flight flag for the background resting-order fill poll (keeps the
   *  slow REST poll OFF the trigger-evaluation hot path). */
  private fillPollInFlight = false
  /** Latency breakdown of the most recent order submission (instrumentation). */
  private lastExecutionLatency: SloExecutionLatency | null = null
  /** SIZING TRANSPARENCY (Phase 5): requested vs effective shares of the most
   *  recent sizing computation — lets the fill audit and the dashboard prove
   *  whether a smaller-than-configured position came from a risk clamp or a
   *  partial fill, never a silent mystery. */
  private lastSizing: { requestedShares: number; effectiveShares: number; sizingMode: string } | null = null
  /** Per-slot set of already-logged in-window withhold reasons (throttle: one
   *  permanent order_log row per reason per slot). */
  private loggedWithholds = new Set<string>()
  /** Human-readable reason the risk gate is blocking orders, or null. Surfaced
   *  in the snapshot so a veto is NEVER invisible on the dashboard. */
  private blockedReason: string | null = null
  /**
   * Idempotency guard: tradeUids already settled. The early-resolution path
   * and the slot-rollover path can both target the same lots, so this ensures
   * a lot is never settled twice (no double bankroll credit / duplicate ledger
   * row / duplicate Telegram card).
   */
  private settledUids = new Set<string>()

  /**
   * BUG #5 (compounding staleness): rolloverSlot dispatches `settleOfficial`
   * asynchronously — the new slot's tick can arm/fire BEFORE the previous
   * slot's payout has been credited to the bankroll. In PERCENT (compounding)
   * mode that produces a position sized from a stale balance. This set holds
   * the tradeUids of positions handed off to settlement but not yet credited;
   * PERCENT sizing refuses to fire while it is non-empty so every compounded
   * order uses the latest settled balance. FIXED_SHARES / FIXED_USD are
   * unaffected because their size does not depend on bankroll.
   */
  private pendingSettlementUids = new Set<string>()

  private slotEndMs = 0
  private strike: number | null = null
  private market: DiscoveredMarket | null = null

  private restingOrder: OpenOrder | null = null
  private restingSide: TradeSide | null = null

  /** All confirmed lots for the CURRENT market, settled together at resolution. */
  private positions: FilledLot[] = []
  /** The majority side locked when that same side reaches the trigger this
   *  market. Null until the majority side triggers. */
  private lockedDirection: TradeSide | null = null
  /**
   * TRIGGER LOCK — frozen market identity captured the instant a direction
   * locks. While present, the engine trades ONLY against this exact
   * generation + market + tokens + slot. It is released ONLY on: order
   * filled, order cancelled, or slot expiry (rollover). A WS reconnect or
   * REST refresh can NEVER cause a relock or re-evaluation of direction.
   * If the feed generation or market changes while locked (rollover
   * mid-fill), the pending order is cancelled and audited — a lock is never
   * carried into a new market.
   */
  private triggerLock: {
    generation: number
    marketId: string
    upTokenId: string
    downTokenId: string
    slotEndMs: number
    lockedAtMs: number
  } | null = null
  /**
   * ATOMIC SNAPSHOT for the CURRENT tick — captured ONCE at tick start from
   * clobPriceFeed.validatedQuotes(). Every decision inside the tick (race,
   * trigger, majority, marketability, paper fill) reads THIS object and never
   * calls the feed again, so torn reads and mixed-generation comparisons are
   * structurally impossible. One tick = one snapshot.
   */
  private tickSnapshot: FeedSnapshot | null = null
  /** The validated snapshot that fired the trigger (persisted into the trade audit). */
  private triggerSnapshot: FeedSnapshot | null = null
  /** True once the single order for the current window has filled. While true
   *  the engine places no further orders and holds until slot rollover. */
  private windowFilled = false
  /**
   * Edge-trigger gate. True when a fresh trigger crossing is allowed to fire
   * an order. Set false after a submission; re-armed once the tradeable-side
   * price falls back below the trigger. Prevents duplicate submissions.
   */
  private readyForTrigger = true

  private majoritySide: TradeSide | null = null
  private majorityPrice = 0
  private lastThrottleKey = ""

  private earlyResolutionChecking = false
  private lastResolutionCheckMs = 0

  /** Submission cooldown after a placement failure (rate-limits retries). */
  private nextSubmitAllowedMs = 0
  /** Last time the stuck-RESTING guard verified the order on the exchange. */
  private lastOrderStateCheckMs = 0

  constructor(deps: Deps) {
    this.deps = deps
    // Restart recovery: if the process died while a standing order was armed,
    // restore it (and any resting order id) so a PM2 restart never silently
    // drops the operator's armed configuration.
    this.restoreFromKv()
  }

  // ---------- restart persistence ----------

  private kvKey(): string {
    return `slo:state:${this.deps.getMode()}`
  }

  /** Persist the armed config + window runtime so a restart can recover. */
  private persistState() {
    try {
      if (!this.params) {
        kvSet(this.kvKey(), "")
        return
      }
      kvSet(
        this.kvKey(),
        JSON.stringify({
          params: this.params,
          paused: this.paused,
          runtime: {
            slotEndMs: this.slotEndMs,
              strike: this.strike,
            lockedDirection: this.lockedDirection,
            windowFilled: this.windowFilled,
            restingOrder: this.restingOrder,
            restingSide: this.restingSide,
            triggerLock: this.triggerLock,
          },
        }),
      )
    } catch {
      /* persistence must never crash the trading path */
    }
  }

  private restoreFromKv() {
    try {
      const raw = kvGet(this.kvKey())
      if (!raw) return
      const saved = JSON.parse(raw) as {
        params?: Partial<Params>
        paused?: boolean
        runtime?: {
          slotEndMs?: number
          strike?: number | null
          lockedDirection?: TradeSide | null
          windowFilled?: boolean
          restingOrder?: OpenOrder | null
          restingSide?: TradeSide | null
          triggerLock?: StandingOrderManager["triggerLock"]
        }
      }
      const p = saved.params
      if (
        !p ||
        typeof p.limitPrice !== "number" ||
        typeof p.triggerPrice !== "number" ||
        typeof p.minPrice !== "number" ||
        typeof p.maxPrice !== "number" ||
        typeof p.shares !== "number"
      )
        return
      this.executor = this.buildExecutor()
      // Sizing + entry window survive restarts (backward compatible: saves
      // from before these fields existed restore as FIXED_SHARES / disabled).
      const savedSizing = (p as { sizingMode?: unknown }).sizingMode
      const sizingMode: SloSizingMode =
        savedSizing === "FIXED_USD" || savedSizing === "PERCENT" ? savedSizing : "FIXED_SHARES"
      const savedSizeValue = (p as { sizeValue?: unknown }).sizeValue
      const sizeValue = typeof savedSizeValue === "number" && savedSizeValue > 0 ? savedSizeValue : p.shares
      const savedWindow = (p as { entryWindowMs?: unknown }).entryWindowMs
      const entryWindowMs = typeof savedWindow === "number" && savedWindow > 0 ? savedWindow : null
      this.params = {
        limitPrice: p.limitPrice,
        triggerPrice: p.triggerPrice,
        minPrice: p.minPrice,
        maxPrice: p.maxPrice,
        shares: p.shares,
        triggerMode: p.triggerMode === "UPWARD_CROSSING" ? "UPWARD_CROSSING" : "AT_OR_ABOVE",
        sizingMode,
        sizeValue,
        entryWindowMs,
      }
      this.paused = saved.paused === true
      this.slotEndMs = currentSlotEndMs()
      this.readyForTrigger = this.params.triggerMode === "AT_OR_ABOVE"
      // Same 5-minute window as before the restart: restore the direction
      // lock, one-shot flag, and any resting order id so the engine adopts
      // its own prior order instead of placing a duplicate. A stale-slot
      // resting order is cancelled best-effort (its market has expired).
      const rt = saved.runtime
      if (rt && rt.slotEndMs === this.slotEndMs) {
        this.strike = Number.isFinite(rt.strike) ? rt.strike : null
        this.lockedDirection = rt.lockedDirection ?? null
        // NOTE: the trigger lock's generation is NOT restored across restarts —
        // the feed's generation counter restarts with the process, so a stale
        // persisted generation would instantly (and wrongly) trip the integrity
        // guard. The lock's market/token/slot identity is re-validated against
        // the restored market instead; the direction lock itself is preserved.
        this.triggerLock = null
        this.windowFilled = rt.windowFilled === true
        if (rt.restingOrder && rt.restingOrder.exchangeOrderId) {
          this.restingOrder = rt.restingOrder
          this.restingSide = rt.restingSide ?? rt.restingOrder.side
          this.readyForTrigger = false
        }
      } else if (rt?.restingOrder && this.executor) {
        void this.executor.cancelOrder(rt.restingOrder).catch(() => {})
      }
      this.status = this.paused ? "PAUSED" : this.restingOrder ? "RESTING" : "ARMED"
      this.startLoop()
      this.deps.clobPriceFeed.setQuoteListener(() => void this.tick())
      startSettlementVerifier(
        () => this.deps.getMode(),
        { creditWallet: (usdDelta) => this.executor?.creditSettlement?.(usdDelta) },
      )
      logEvent(
        "warn",
        `Standing limit order RESTORED after restart: BUY ${this.params.shares} @ $${this.params.limitPrice.toFixed(2)}, trigger $${this.params.triggerPrice.toFixed(2)} [${this.params.triggerMode}]${this.paused ? " (paused)" : ""}${this.restingOrder ? ` — adopted resting order ${this.restingOrder.exchangeOrderId}` : ""} — in-memory positions from the previous process were recovered as SCRATCH at boot`,
      )
    } catch (e) {
      logEvent("warn", `Standing limit restore skipped: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ---------- public API ----------

  get active(): boolean {
    return this.params !== null
  }

  /** The resting exchange order this manager is tracking (for reconciliation). */
  get trackedRestingOrder(): OpenOrder | null {
    return this.restingOrder
  }

  /**
   * Arm the standing limit order. Does NOT submit immediately — it begins
   * monitoring the majority side and submits a LIMIT BUY at the target only
   * once the tradeable-side price reaches the trigger. After the first fill
   * the direction locks for the remainder of the market.
   */
  arm(
    limitPrice: number,
    shares: number,
    minShares: number,
    minPrice?: number,
    maxPrice?: number,
    triggerPrice?: number,
    triggerMode?: TriggerMode,
    opts?: {
      /** Position sizing model (default FIXED_SHARES = legacy behavior). */
      sizingMode?: SloSizingMode
      /** Share count | dollar amount | percent of pool, per sizingMode. */
      sizeValue?: number
      /** FINAL entry window in SECONDS before settlement, or null/0 = disabled. */
      entryWindowSec?: number | null
    },
  ): string {
    const target = Math.round(limitPrice * 100) / 100
    if (!(target > 0 && target < 1)) return "Target price must be between 0.01 and 0.99"

    // ---- Sizing model validation (fail fast at arm time) ----
    const sizingMode: SloSizingMode = opts?.sizingMode ?? "FIXED_SHARES"
    const sizeValue = opts?.sizeValue ?? shares
    const maxShares = this.deps.risk.getLimits().maxSharesPerOrder
    if (sizingMode === "FIXED_SHARES") {
      if (!(shares >= minShares)) return `Shares must be at least ${minShares}`
      // Fat-finger protection: an absurd count is rejected here, not 14 minutes
      // later when the trigger crosses.
      if (!Number.isInteger(shares)) return "Shares must be a whole number"
      if (shares > maxShares) return `Shares must be at most ${maxShares} (risk limit maxSharesPerOrder)`
    } else if (sizingMode === "FIXED_USD") {
      if (!(Number.isFinite(sizeValue) && sizeValue > 0)) return "Dollar amount must be greater than $0"
      // The order must afford at least minShares at the target price.
      if (Math.floor(sizeValue / target) < minShares)
        return `$${sizeValue.toFixed(2)} buys fewer than ${minShares} share(s) at $${target.toFixed(2)}`
    } else {
      // PERCENT — automatic compounding.
      if (!(Number.isFinite(sizeValue) && sizeValue >= 1 && sizeValue <= 100))
        return "Percent of pool must be between 1 and 100"
    }

    // ---- Entry time window validation ----
    const windowSec = opts?.entryWindowSec ?? null
    let entryWindowMs: number | null = null
    if (windowSec !== null && windowSec !== 0) {
      if (!(SLO_WINDOW_OPTIONS_SEC as readonly number[]).includes(windowSec))
        return `Time window must be one of ${SLO_WINDOW_OPTIONS_SEC.join("/")} seconds (or disabled)`
      entryWindowMs = windowSec * 1000
    }

    // Trigger is fully user-defined. Default to one tick below target only
    // when the caller omits it. It must sit at or below the target so the
    // triggered LIMIT BUY is marketable (ask ≤ target) when it fires.
    const trigger =
      triggerPrice === undefined
        ? Math.round((target - TICK) * 1000) / 1000
        : Math.round(triggerPrice * 1000) / 1000
    if (!(trigger > 0)) return "Trigger price must be greater than $0.00"
    if (trigger > target) return "Trigger price must be at or below the target price"

    // Guardrails: default to a wide band around the target if unset.
    const lo = Math.round((minPrice ?? 0.01) * 100) / 100
    const hi = Math.round((maxPrice ?? 0.99) * 100) / 100
    if (lo >= hi) return "Minimum price must be below maximum price"

    try {
      this.executor = this.buildExecutor()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logEvent("error", `Standing limit order not armed: ${msg}`)
      return msg
    }

    this.cancelRestingOrder()

    // If there are live open positions from a previously-armed order that were
    // never settled (e.g. the user cancelled-and-re-armed mid-slot), close the
    // stale ledger rows as SCRATCH before arming the new order so the ledger
    // never shows permanently-open rows from the previous arm.
    this.scratchOpenPositions("re-arm")

    const mode = triggerMode ?? DEFAULT_TRIGGER_MODE
    this.params = {
      limitPrice: target,
      triggerPrice: trigger,
      minPrice: lo,
      maxPrice: hi,
      shares,
      triggerMode: mode,
      sizingMode,
      sizeValue,
      entryWindowMs,
    }
    this.paused = false
    // Clear any hung busy flag from a previous session (a ghost promise from a
    // stuck network call) so a re-arm ALWAYS yields a working engine — without
    // this, cancelling and re-creating the SLO could not recover a stalled loop.
    this.busy = false
    this.blockedReason = null
    this.status = "ARMED"
    this.executionCount = 0
    this.lastExecutedAtMs = null
    this.slotEndMs = currentSlotEndMs()
    this.strike = null
    this.market = this.deps.discovery.peek(this.slotEndMs)
    this.positions = []
    this.lockedDirection = null
    this.triggerLock = null
    this.triggerSnapshot = null
    this.windowFilled = false
    // Gate init by mode:
    //  • UPWARD_CROSSING: start CLOSED. If the price is already at/above the
    //    trigger at arm time we must wait for a fresh crossing (dip below, then
    //    rise back through) rather than firing immediately. The tick's
    //    below-trigger branch opens the gate once the price drops under it.
    //  • AT_OR_ABOVE: start OPEN so it can fire the moment price is at/above.
    this.readyForTrigger = mode === "AT_OR_ABOVE"
    this.earlyResolutionChecking = false
    this.lastResolutionCheckMs = 0
    this.lastThrottleKey = ""
    this.nextSubmitAllowedMs = 0
    this.lastOrderStateCheckMs = 0
    this.persistState()

    logEvent(
      "info",
      `Standing limit order armed: BUY ${shares} @ $${target.toFixed(2)} target, trigger $${trigger.toFixed(2)} [${mode}], band $${lo.toFixed(2)}–$${hi.toFixed(2)} — BTC-reference majority side only, opposite-side trigger touches ignored, one order per 5-min window`,
    )

    this.startLoop()
    // Event-driven trigger: evaluate the moment a live price moves (WS push)
    // instead of waiting for the next timer tick. The tick's `busy` guard makes
    // this safe against overlap; the timer chain remains as a heartbeat/fallback.
    this.deps.clobPriceFeed.setQuoteListener(() => void this.tick())
    // Post-settlement integrity net: audits recent SETTLED rows against the
    // official Polymarket resolution and raises a CRITICAL alert on mismatch.
    startSettlementVerifier(
        () => this.deps.getMode(),
        { creditWallet: (usdDelta) => this.executor?.creditSettlement?.(usdDelta) },
      )
    void this.tick()

    notify(
      "orders",
      "STANDING ORDER ARMED",
      `BUY ${shares} @ $${target.toFixed(2)} target\nTrigger: $${trigger.toFixed(2)} [${mode}]\nBTC-reference majority side only — opposite-side triggers ignored`,
    )
    return `Standing limit order armed: will BUY ${shares} @ $${target.toFixed(2)} only when the BTC-reference majority side reaches trigger $${trigger.toFixed(2)}`
  }

  /** Cancel the standing limit order and stop the loop entirely. */
  cancel(): string {
    if (!this.params) return "No standing limit order to cancel"
    const summary = `@ $${this.params.limitPrice.toFixed(2)} (${this.executionCount} fills)`
    this.cancelRestingOrder()
    // Invalidate any in-flight tick BEFORE tearing state down, so a hung tick
    // resuming later can never mutate the now-cancelled configuration.
    this.bumpEpoch("cancel")
    this.stopLoop()
    // Detach the event-driven trigger listener so WS pushes stop ticking a
    // cancelled order.
    this.deps.clobPriceFeed.setQuoteListener(null)

    // If we are holding positions and the user explicitly cancels before slot
    // rollover, close the open ledger rows as SCRATCH so nothing is left
    // permanently OPEN in the transaction history.
    this.scratchOpenPositions("cancel")

    this.params = null
    this.paused = false
    this.positions = []
    this.lockedDirection = null
    this.triggerLock = null
    this.triggerSnapshot = null
    this.tickSnapshot = null
    this.windowFilled = false
    this.readyForTrigger = true
    this.market = null
    this.majoritySide = null
    this.majorityPrice = 0
    this.earlyResolutionChecking = false
    this.persistState()
    logEvent("info", `Standing limit order cancelled: ${summary}`)
    return "Standing limit order cancelled"
  }

  /**
   * Teardown ONLY — stop the internal poll loop without mutating params, the
   * ledger, or open positions. Called when the owning engine singleton is being
   * discarded (e.g. an HMR/version rebuild) so the old instance's setInterval is
   * not orphaned. An orphaned loop would keep ticking against the shared price
   * feed and ledger alongside the new engine's loop, causing duplicate fills and
   * direction-lock flapping.
   */
  dispose(): void {
    this.bumpEpoch("dispose")
    this.stopLoop()
    try {
      this.deps.clobPriceFeed.setQuoteListener(null)
    } catch {
      /* ignore */
    }
    this.busy = false
  }

  /** Pause monitoring/submission without losing the configuration. */
  pause(): string {
    if (!this.params) return "No standing limit order to pause"
    if (this.paused) return "Standing limit order already paused"
    this.paused = true
    this.status = "PAUSED"
    // Invalidate any in-flight tick so a hung await resuming later cannot
    // place an order against a paused configuration.
    this.bumpEpoch("pause")
    // Drop any resting order so nothing fills while paused.
    this.cancelRestingOrder()
    this.persistState()
    logEvent("info", "Standing limit order paused — monitoring suspended, resting order cancelled")
    return "Standing limit order paused"
  }

  /** Resume monitoring after a pause. */
  resume(): string {
    if (!this.params) return "No standing limit order to resume"
    if (!this.paused) return "Standing limit order is not paused"
    this.paused = false
    // Same ghost-promise protection as arm(): resuming must never inherit a
    // hung busy flag from a stalled previous tick.
    this.busy = false
    this.status = this.positions.length ? "FILLED" : "ARMED"
    this.lastThrottleKey = ""
    this.persistState()
    logEvent("info", "Standing limit order resumed — monitoring the locked/majority side again")
    void this.tick()
    return "Standing limit order resumed"
  }

  /** Called by the engine when the pipeline mode changes. Rebuilds the executor. */
  onModeChanged() {
    if (!this.params) return
    try {
      this.executor = this.buildExecutor()
    } catch {
      /* executor rebuild deferred to next arm */
    }
  }

  snapshot(): StandingLimitOrder | null {
    if (!this.params) return null

    // Aggregate every open lot for the current market into a single net
    // position so the ledger reflects the live exposure and unrealized PnL
    // the instant fills are confirmed (never waiting for market resolution).
    let openPosition: StandingLimitOrder["openPosition"] = null
    if (this.positions.length > 0) {
      const side = this.lockedDirection ?? this.positions[0].side
      // Live best-ask mark, or null when the CLOB feed is not fresh. We never
      // substitute a modeled/cached value — the UI shows the PnL as pending.
      const mark = this.displayMarkForSide(side)
      const markFresh = mark !== null
      const totalShares = this.positions.reduce((a, p) => a + p.shares, 0)
      const totalCost = Math.round(this.positions.reduce((a, p) => a + p.cost, 0) * 10000) / 10000
      const entryPrice = totalShares > 0 ? Math.round((totalCost / totalShares) * 10000) / 10000 : 0
      const positionValue = mark === null ? null : Math.round(totalShares * mark * 10000) / 10000
      const unrealizedPnl = positionValue === null ? null : Math.round((positionValue - totalCost) * 10000) / 10000
      openPosition = {
        marketId: this.positions[0].marketId,
        side,
        entryPrice,
        shares: totalShares,
        cost: totalCost,
        filledAtMs: this.lastExecutedAtMs ?? Date.now(),
        markPrice: mark,
        markFresh,
        positionValue,
        unrealizedPnl,
      }
    }

    const cachedMarket = this.deps.discovery.peek(this.slotEndMs)

    return {
      limitPrice: this.params.limitPrice,
      triggerPrice: this.params.triggerPrice,
      triggerMode: this.params.triggerMode,
      minPrice: this.params.minPrice,
      maxPrice: this.params.maxPrice,
      // Live estimate for the NEXT order (recomputed authoritatively at fire
      // time). For FIXED_SHARES this is the configured count; for FIXED_USD /
      // PERCENT it reflects the current bankroll — i.e. the compounded size.
      shares: this.computeOrderShares(this.params.limitPrice),
      sizingMode: this.params.sizingMode,
      sizeValue: this.params.sizeValue,
      entryWindowMs: this.params.entryWindowMs,
      entryWindowOpensInMs: this.entryWindowOpensInMs(),
      executionCount: this.executionCount,
      lastExecutedAtMs: this.lastExecutedAtMs,
      status: this.status,
      majoritySide: this.majoritySide,
      majorityPrice: this.majorityPrice,
      lockedDirection: this.lockedDirection,
      openPositionCount: this.positions.length,
      restingSide: this.restingSide,
      slotEndMs: this.slotEndMs,
      paused: this.paused,
      live: this.deps.getMode() === "LIVE_V2",
      openPosition,
      marketClosed: cachedMarket?.closed ?? false,
      awaitingEarlySettlement: this.earlyResolutionChecking,
      blockedReason: this.blockedReason,
      lastExecutionLatency: this.lastExecutionLatency,
      lastSizing: this.lastSizing,
    }
  }

  // ---------- internals ----------

  /**
   * AUTOMATIC COMPOUNDING — compute the share count for the NEXT order from
   * the CURRENT ledger-authoritative bankroll (balance + dust reserve), at the
   * moment of the call (fire time). Identical in PAPER_V1 and LIVE_V2, since
   * both share the same Bankroll seam that phase-2 verified against the ledger.
   *
   *  • FIXED_SHARES — the configured count (legacy).
   *  • FIXED_USD    — floor(usd / limitPrice).
   *  • PERCENT      — floor(pool × pct/100 / limitPrice). Every settlement
   *    credits the pool synchronously before the next tick can fire, so each
   *    order automatically sizes from the compounded balance.
   *
   * Returns 0 when the pool cannot afford a single share (caller surfaces
   * INSUFFICIENT). The result is always capped by risk maxSharesPerOrder.
   */
  private computeOrderShares(limitPrice: number): number {
    if (!this.params) return 0
    const { sizingMode, sizeValue, shares } = this.params
    let n: number
    if (sizingMode === "FIXED_USD") {
      n = Math.floor(sizeValue / limitPrice)
    } else if (sizingMode === "PERCENT") {
      const bankroll = this.deps.getBankroll()
      const pool = bankroll.balance + bankroll.dustReserve
      const budget = (pool * sizeValue) / 100
      n = Math.floor(budget / limitPrice)
    } else {
      n = shares
    }
    const maxShares = this.deps.risk.getLimits().maxSharesPerOrder
    const capped = Math.max(0, Math.min(n, maxShares))
    // SIZING TRANSPARENCY (Phase 5): the risk cap is a safety net, but when it
    // ALTERS the operator's explicit number it must be loud, not silent — a
    // silently-clamped FIXED_SHARES order looks like the engine "changed the
    // shares by itself". Permanent order_log row + warn, once per slot.
    if (capped < n) {
      const key = `riskclamp-${this.slotEndMs}`
      if (!this.loggedWithholds.has(key)) {
        this.loggedWithholds.add(key)
        logEvent(
          "warn",
          `Standing limit: risk cap CLAMPED order size ${n} → ${capped} shares (maxSharesPerOrder=${maxShares}, mode ${sizingMode}) — the operator's configured size was reduced by the risk gate`,
        )
        insertOrderLog({
          mode: this.deps.getMode(),
          event: "WITHHELD",
          marketId: this.market?.conditionId ?? `slot-${this.slotEndMs}`,
          side: this.lockedDirection ?? this.majoritySide ?? "UP",
          price: limitPrice,
          shares: capped,
          phase: "WAITING",
          detail: `RISK_CLAMP: requested ${n} shares (${sizingMode}) clamped to ${capped} by maxSharesPerOrder=${maxShares}`,
        })
      }
    }
    // Expose requested vs effective for the snapshot + fill-audit comparison.
    this.lastSizing = { requestedShares: n, effectiveShares: capped, sizingMode }
    return capped
  }

  /**
   * FINAL ENTRY WINDOW — ms until the window OPENS for the CURRENT market.
   * The window is the LAST `entryWindowMs` of the market, anchored to
   * SETTLEMENT (slotEndMs) using the drift-corrected synced clock:
   *
   *   remaining = slotEndMs − now
   *   eligible  ⇔ remaining ≤ entryWindowMs
   *
   * Returns:
   *   null  — window disabled
   *   > 0   — window NOT open yet (ms until it opens); monitoring only
   *   0     — window ACTIVE: orders may fire until settlement
   *
   * The window closes AT settlement — rollover replaces slotEndMs, which
   * automatically restarts the cycle for the next market. Stateless: no
   * separate timer exists, so there is nothing to drift, stall, or
   * double-fire, and restarts/refreshes cannot reset it.
   */
  private entryWindowOpensInMs(): number | null {
    const windowMs = this.params?.entryWindowMs ?? null
    if (windowMs === null) return null
    const remaining = this.slotEndMs - nowMs()
    return Math.max(0, remaining - windowMs)
  }

  /** The ONE interchangeable execution backend (same seam as the engine's):
   *  PAPER_V1 → simulated exchange, LIVE_V2 → real Polymarket. Fill decisions
   *  in paper read the LIVE CLOB best-ask via priceForSide (real market data);
   *  when live data is missing priceForSide is null and nothing can fill
   *  (defense-in-depth — the tick already holds on NO_DATA before any order
   *  rests). There is NO liquidity/volume gate: as a liquidity provider the
   *  bot posts the resting order itself, so once the price condition is met
   *  the order fills instantly. */
  private buildExecutor(): Executor {
    if (this.deps.getMode() === "LIVE_V2") {
      const { LiveExecutor } = require("./execution/live") as typeof import("./execution/live")
      return new LiveExecutor()
    }
    // Paper fill decisions read THIS TICK's atomic validated snapshot via
    // executionPriceForSide — same choke point as the trigger, so a fill can
    // never be decided on data the trigger did not see.
    return new PaperExecutor((side) => this.executionPriceForSide(side))
  }

  private freshSpotPrice(): number | null {
    const tick = this.deps.spotFeed.latest
    if (!tick) return null
    if (Date.now() - tick.tsMs > SPOT_STALE_MS) return null
    return tick.price
  }

  /**
   * EXECUTION price for a side, read from THIS TICK's atomic validated
   * snapshot — the single choke point for every decision path (trigger, race,
   * majority, marketability, paper fills). Returns NULL when no validated
   * snapshot exists for this tick or its confidence is LOW: execution must
   * reject LOW-confidence data and HOLD rather than trade on it. There is NO
   * model, cache, or estimate fallback.
   */
  private executionPriceForSide(side: TradeSide): number | null {
    const snap = this.tickSnapshot
    if (!snap || snap.confidence === "LOW") return null
    return side === "UP" ? snap.up.price : snap.down.price
  }

  /**
   * DISPLAY-ONLY mark for a side (ledger marks, dashboard PnL). Reads a fresh
   * validated pair (generation + identity + freshness gated) but accepts any
   * confidence, since a slightly-aged mark is better than a blank display.
   * NEVER used for trigger, race, sizing, or fill decisions.
   */
  private displayMarkForSide(side: TradeSide): number | null {
    const snap = this.deps.clobPriceFeed.validatedQuotes()
    if (!snap) return null
    return side === "UP" ? snap.up.price : snap.down.price
  }

  /**
   * Majority side = current BTC candle direction, derived from a fresh BTC
   * reference tick versus the captured candle strike. The returned price is the
   * CLOB best-ask for that majority side from the same atomic snapshot used for
   * trigger detection. Returns { side: null } when either the CLOB snapshot or
   * the BTC reference direction is unavailable so the engine holds instead of
   * guessing. This prevents an illiquid/stale high ask on the opposite contract
   * from becoming a false "majority" and triggering a wrong-side order.
   */
  private computeMajority(snap: FeedSnapshot | null): { side: TradeSide | null; price: number } {
    if (!snap) return { side: null, price: 0 }
    let side = this.btcReferenceDirection()
    if (!side && this.strike !== null && this.freshSpotPrice() !== null) {
      // Exact BTC tie versus strike: there is no directional move, so fall back
      // to the market's own higher-priced contract. Missing/stale BTC still
      // returns null above and HOLDs.
      side = snap.up.price >= snap.down.price ? "UP" : "DOWN"
    }
    if (!side) return { side: null, price: 0 }
    return { side, price: side === "UP" ? snap.up.price : snap.down.price }
  }

  private btcReferenceDirection(): TradeSide | null {
    if (this.strike === null) return null
    const spot = this.freshSpotPrice()
    if (spot === null) return null
    if (spot > this.strike) return "UP"
    if (spot < this.strike) return "DOWN"
    return null
  }

  private orderIds(side: TradeSide): { marketId: string; tokenId: string } | null {
    const m = this.market
    if (m && m.slotEndMs === this.slotEndMs) {
      return { marketId: m.slug, tokenId: side === "UP" ? m.upTokenId : m.downTokenId }
    }
    // Both pipelines use real Gamma-discovered ids — synthetic ids would
    // break the live CLOB fill-decision reads.
    return null
  }

  /**
   * NO SILENT SKIPS: when the entry window is OPEN but the engine withholds a
   * trigger/submission, write a PERMANENT order_log row (event WITHHELD) so
   * every in-window non-action is forensically explained. Throttled to one
   * row per reason-kind per slot (this.loggedWithholds, cleared on rollover)
   * so a persistent condition cannot flood the log.
   */
  private logWithheld(kind: string, detail: string) {
    // Only report when the entry window is actually open — outside it,
    // holding is normal scheduled behavior, not a withheld opportunity.
    const opensIn = this.entryWindowOpensInMs()
    if (opensIn !== null && opensIn > 0) return
    const key = `${kind}-${this.slotEndMs}`
    if (this.loggedWithholds.has(key)) return
    this.loggedWithholds.add(key)
    insertOrderLog({
      mode: this.deps.getMode(),
      event: "WITHHELD",
      marketId: this.market?.conditionId ?? `slot-${this.slotEndMs}`,
      tokenId: this.market?.upTokenId ?? null,
      side: this.lockedDirection ?? this.majoritySide ?? "UP",
      price: this.params?.limitPrice,
      shares: this.params?.shares,
      phase: "WAITING",
      detail: `in-window withhold [${kind}]: ${detail.slice(0, 300)}`,
    })
  }

  private throttledLog(key: string, level: "info" | "warn", msg: string) {
    if (this.lastThrottleKey === key) return
    this.lastThrottleKey = key
    logEvent(level, msg)
  }

  // ---------- adaptive scheduler + tick-epoch machinery ----------

  /**
   * Start (or restart) the self-scheduling tick chain. Replaces the old fixed
   * setInterval: each pass runs tick() and then schedules the next pass at an
   * adaptive delay — HOT_LOOP_MS when execution timing matters (inside the
   * entry window, within WINDOW_APPROACH_MS of it opening, or in the final
   * SLOT_FINAL_HOT_MS of the slot), LOOP_MS otherwise.
   */
  private startLoop() {
    this.stopLoop()
    const run = async () => {
      try {
        await this.tick()
      } finally {
        // Re-check inside the closure: cancel()/dispose() may have stopped the
        // chain while the tick was in flight (loop === null means "stopped").
        if (this.loop !== null) {
          this.loop = setTimeout(run, this.currentCadenceMs())
        }
      }
    }
    // Non-null sentinel so the chain knows it is alive before the first pass.
    this.loop = setTimeout(run, 0)
  }

  /** Stop the tick chain and the precise window-open timer. */
  private stopLoop() {
    if (this.loop) {
      clearTimeout(this.loop)
      this.loop = null
    }
    if (this.windowOpenTimer) {
      clearTimeout(this.windowOpenTimer)
      this.windowOpenTimer = null
    }
  }

  /** The adaptive inter-tick delay for the CURRENT instant. */
  private currentCadenceMs(): number {
    if (!this.params) return LOOP_MS
    const remaining = this.slotEndMs - nowMs()
    if (remaining > 0 && remaining <= SLOT_FINAL_HOT_MS) return HOT_LOOP_MS
    const opensIn = this.entryWindowOpensInMs()
    if (opensIn !== null && opensIn <= WINDOW_APPROACH_MS) return HOT_LOOP_MS
    return LOOP_MS
  }

  /**
   * Arm a precise one-shot timer that fires tick() at the EXACT window-open
   * instant. Re-armed on every WINDOW_WAITING tick (cheap — it replaces the
   * previous timer), so clock drift is continuously corrected. Without this,
   * a 1s timer phase could waste up to 20% of a 5s window before the first
   * in-window evaluation.
   */
  private armWindowOpenTimer(opensInMs: number) {
    if (this.windowOpenTimer) clearTimeout(this.windowOpenTimer)
    this.windowOpenTimer = setTimeout(() => {
      this.windowOpenTimer = null
      void this.tick()
    }, opensInMs)
  }

  /**
   * Invalidate any in-flight tick. Called on busy-watchdog fire, rollover,
   * cancel/pause/dispose, and watchdog kick — every point where state captured
   * by a running tick may no longer describe the current world.
   */
  private bumpEpoch(reason: string): void {
    this.tickEpoch++
    // The reason is logged by callers with more context; keep a debug-level
    // trace here so epoch bumps are always countable in the event log.
    void reason
  }

  /** Liveness health for the engine-level watchdog (never touches orders). */
  getLoopHealth(): { active: boolean; paused: boolean; lastTickStartMs: number; lastTickCompletedMs: number } {
    return {
      active: this.params !== null && this.loop !== null,
      paused: this.paused,
      lastTickStartMs: this.lastTickStartMs,
      lastTickCompletedMs: this.lastTickCompletedMs,
    }
  }

  /** Total cost of open (unsettled) lots — Identity C input for the
   *  accounting verifier (fills were debited but not yet settled back). */
  getOpenCostUsd(): number {
    return Math.round(this.positions.reduce((s, p) => s + p.cost, 0) * 10000) / 10000
  }

  /** Configured sizing for Identity D (FIXED_SHARES conformance checks). */
  getConfiguredSizing(): { sizingMode: string; shares: number } | null {
    if (!this.params) return null
    return { sizingMode: this.params.sizingMode, shares: this.params.shares }
  }

  /**
   * Watchdog recovery: restart a stalled tick chain. Invalidate any ghost
   * tick, clear the busy flag (its owner is by definition stalled), and
   * restart the timer chain. Idempotent and safe — no order state is touched;
   * the next tick re-derives everything from persisted/market state.
   */
  kickLoop(reason: string): void {
    if (!this.params) return
    this.bumpEpoch(`kick: ${reason}`)
    this.busy = false
    logEvent("warn", `Standing limit loop KICKED (${reason}) — timer chain restarted, ghost ticks invalidated`)
    this.startLoop()
  }

  private async tick() {
    if (!this.params || !this.executor) return
    if (this.paused) return
    if (this.busy) {
      // DEADLOCK GUARD (mirrors the main engine loop): if a previous tick has
      // been in-flight for longer than BUSY_STUCK_MS its awaited network call
      // hung — without this reset the flag would stay true FOREVER and every
      // subsequent tick would return here, silently halting the SLO for the
      // rest of the process lifetime (armed, looks healthy, never trades).
      if (Date.now() - this.lastTickStartMs > BUSY_STUCK_MS) {
        this.busy = false
        // GHOST-TICK INVALIDATION: the hung tick's promise is still alive and
        // WILL resume when its network call finally settles. Bumping the epoch
        // guarantees it abandons at its next resume point instead of mutating
        // live state concurrently with the new tick (the previous behavior —
        // the root cause of duplicate-execution and corrupted-state risk).
        this.bumpEpoch("busy-watchdog")
        logEvent(
          "warn",
          `Standing limit busy-watchdog fired — previous tick hung >${BUSY_STUCK_MS / 1000}s on a stuck call; flag reset and ghost tick invalidated so trading continues safely`,
        )
      }
      return
    }
    this.busy = true
    this.lastTickStartMs = Date.now()
    // Capture this tick's epoch. After EVERY await below, `myEpoch !==
    // this.tickEpoch` means the world changed while we were suspended
    // (busy-watchdog fired, rollover, cancel, kick) — abandon immediately.
    let myEpoch = this.tickEpoch
    try {
      const slotEnd = currentSlotEndMs()

      // 5-minute slot rollover: previous market closed. Settle & re-arm.
      if (slotEnd !== this.slotEndMs) {
        // Rollover bumps the epoch (killing ghost ticks from the OLD slot);
        // this tick legitimately owns the new slot, so it re-syncs and
        // continues. Any OTHER suspended tick abandons at its next check.
        await this.rolloverSlot(slotEnd)
        if (this.tickEpoch !== myEpoch + 1 && this.tickEpoch !== myEpoch) return // a cancel/kick raced the rollover
        myEpoch = this.tickEpoch
      }

      // Capture the candle strike from the first fresh spot tick.
      if (this.strike === null) {
        const fresh = this.freshSpotPrice()
        if (fresh !== null) this.strike = fresh
      }

      // Keep the CLOB feed pointed at this slot's tokens so live prices
      // flow even while the strategy engine is stopped.
      if (this.market && this.market.slotEndMs === this.slotEndMs) {
        this.deps.clobPriceFeed.setTokenIds(this.market.upTokenId, this.market.downTokenId)
      } else {
        // No market for the CURRENT slot — either never resolved or the cached
        // record is stale (previous slot). A stale record previously fell into
        // a dead zone where discovery was never retried, leaving the engine in
        // WAITING_MARKET for the rest of the window. Clear it and re-resolve.
        if (this.market) this.market = null
        void this.deps.discovery.resolve(this.slotEndMs).then((m) => {
          if (m && m.slotEndMs === this.slotEndMs) {
            this.market = m
            logEvent(
              "info",
              `[SLO] Market resolved: ${m.question || m.slug} | UP token …${m.upTokenId.slice(-12)} | DOWN token …${m.downTokenId.slice(-12)} | conditionId ${m.conditionId.slice(0, 12)}…`,
            )
            this.deps.clobPriceFeed.setTokenIds(m.upTokenId, m.downTokenId)
          }
        }).catch((e) => {
          // Never let a discovery failure become an unhandled rejection —
          // the next tick retries via this same dead-zone recovery path.
          logEvent("warn", `[SLO] market re-resolve failed: ${e instanceof Error ? e.message : String(e)}`)
        })
      }

      // ---- ONE TICK = ONE SNAPSHOT ----
      // Capture the atomic validated snapshot exactly once. EVERY decision in
      // the remainder of this tick (majority, race, trigger, band check,
      // marketability, paper fill) reads this object — never the feed again.
      this.tickSnapshot = this.deps.clobPriceFeed.validatedQuotes()

      // ---- TRIGGER LOCK INTEGRITY GUARD ----
      // If the feed generation or market identity changed while a direction
      // is locked (market re-discovered / rolled mid-lock without the slot
      // boundary having advanced yet), the lock's world no longer exists.
      // Cancel any pending order, audit the event, and release the lock —
      // it must NEVER be carried into a different market. (Ordinary WS
      // reconnects / REST refreshes do not change the generation, so they
      // can never trip this guard — the lock survives them untouched.)
      if (this.triggerLock) {
        const lock = this.triggerLock
        const feedGen = this.deps.clobPriceFeed.generation
        const marketChanged =
          this.market !== null &&
          this.market.slotEndMs === this.slotEndMs &&
          (this.market.upTokenId !== lock.upTokenId || this.market.downTokenId !== lock.downTokenId)
        if (feedGen !== lock.generation || marketChanged) {
          const hadResting = this.restingOrder !== null
          if (hadResting) this.cancelRestingOrder()
          logEvent(
            "warn",
            `Standing limit TRIGGER LOCK RELEASED: market identity changed while locked (generation ${lock.generation} → ${feedGen}${marketChanged ? ", token IDs changed" : ""}) — ${hadResting ? "pending order cancelled, " : ""}lock audited and cleared, direction will re-race on the new market`,
          )
          insertOrderLog({
            mode: this.deps.getMode(),
            event: "CANCELLED",
            marketId: lock.marketId,
            tokenId: lock.upTokenId,
            exchangeOrderId: this.restingOrder?.exchangeOrderId ?? null,
            side: this.lockedDirection ?? "UP",
            price: this.params.limitPrice,
            shares: 0,
            phase: "WAITING",
            detail: `trigger-lock integrity: generation ${lock.generation} → ${feedGen} while locked — lock released, ${hadResting ? "pending order cancelled" : "no pending order"}`,
          })
          this.triggerLock = null
          this.lockedDirection = null
          this.triggerSnapshot = null
          this.readyForTrigger = this.params.triggerMode === "AT_OR_ABOVE"
          this.persistState()
        }
      }

      // Continuously recompute the live majority side (for display / pre-lock)
      // from the SAME snapshot the trigger will use.
      const majority = this.computeMajority(this.tickSnapshot)
      this.majoritySide = majority.side
      this.majorityPrice = majority.price

      // Keep every open lot's live mark + unrealized PnL current, and poll for
      // early market resolution so positions never stay OPEN after close.
      if (this.positions.length > 0) {
        this.refreshOpenMarks()
        void this.checkEarlyResolution()
      }

      const { limitPrice, triggerPrice, minPrice, maxPrice } = this.params

      // ONE ORDER PER WINDOW: once the single order for this 5-minute market has
      // filled, the engine is done for the window. It places no further orders
      // and just holds the position (marks + early resolution refreshed above)
      // until the slot rolls over. Enforces the single-shot execution model.
      if (this.windowFilled) {
        if (this.restingOrder) this.cancelRestingOrder()
        if (!this.paused) this.status = "FILLED"
        return
      }

      // FINAL ENTRY WINDOW: when configured, the trigger may only fire during
      // the LAST N seconds before settlement. Until then the engine keeps
      // monitoring live prices (marks + early resolution refreshed above) but
      // NEVER places an order and NEVER remembers pre-window trigger touches:
      //  • Trigger evaluation is fully skipped while waiting, so a price that
      //    touched the trigger at T-2:10 and moved away leaves NO trace.
      //  • For UPWARD_CROSSING the gate is forcibly CLOSED every waiting tick,
      //    so a crossing that happened before the window opened can never
      //    satisfy the gate — only a fresh crossing INSIDE the window fires.
      // The check is stateless (synced clock vs slotEndMs), so PM2 restarts,
      // dashboard refreshes, and browser closes cannot reset or drift it;
      // rollover to the next market restarts the cycle automatically.
      const windowOpensIn = this.entryWindowOpensInMs()
      if (windowOpensIn !== null && windowOpensIn > 0) {
        if (this.params.triggerMode === "UPWARD_CROSSING") this.readyForTrigger = false
        // PRECISE WINDOW-OPEN TICK: fire an evaluation at the exact instant
        // the window opens (re-armed each waiting tick so drift is corrected)
        // instead of waiting for the next timer-chain pass.
        this.armWindowOpenTimer(windowOpensIn)
        if (this.positions.length === 0 && !this.restingOrder) {
          this.status = "WINDOW_WAITING"
          this.throttledLog(
            `window-waiting-${this.slotEndMs}`,
            "info",
            `Standing limit monitoring — final entry window (${((this.params.entryWindowMs ?? 0) / 1000).toFixed(0)}s before settlement) opens in ${(windowOpensIn / 1000).toFixed(0)}s`,
          )
        }
        return
      }

      // WINDOW-OPEN DIRECTION LOCK (Bug #002 fix).
      //  • Per the strategy spec, the majority side must be locked at the
      //    instant the execution window opens — NOT at trigger fire. Locking
      //    later allowed the BTC-reference majority to flip between window
      //    open and trigger (spot oscillating across strike), which meant a
      //    late-flip minority side could end up locked when it happened to
      //    hit the trigger first.
      //  • First tick inside the open window with a real BTC-reference
      //    majority freezes lockedDirection. Every subsequent tick evaluates
      //    ONLY that side. If majority is unavailable at window open (stale
      //    BTC feed or no CLOB snapshot yet) we HOLD until a real majority
      //    appears — the engine never guesses a side.
      //  • The trigger lock (generation + market identity snapshot) is still
      //    taken when the trigger fires, on top of this earlier lock.
      if (this.lockedDirection === null) {
        if (majority.side === null) {
          if (this.restingOrder) this.cancelRestingOrder()
          if (!this.paused) this.status = "NO_DATA"
          this.throttledLog(
            `window-lock-nodata-${this.slotEndMs}`,
            "warn",
            "Standing limit HOLDING at window open: no BTC-reference majority available to lock direction (waiting for fresh spot / CLOB snapshot)",
          )
          this.logWithheld(
            "window-open-no-majority",
            "window opened but no BTC-reference majority available to lock direction",
          )
          return
        }
        this.lockedDirection = majority.side
        logEvent(
          "info",
          `Standing limit DIRECTION LOCKED at window open: BTC-reference majority ${majority.side} (spot vs strike ${this.strike?.toFixed(2) ?? "?"}) — only this side is monitored for the trigger for the rest of the slot`,
        )
        this.persistState()
      }


      // MAJORITY-SIDE TRIGGER + DIRECTION LOCK.
      //  • Before a side is locked, choose the current BTC-reference majority
      //    side (spot above strike = UP, spot below strike = DOWN) and evaluate
      //    ONLY that side against the trigger.
      //  • Opposite-side trigger touches are ignored. This is the production
      //    fix for intermittent wrong-side entries where an illiquid/stale high
      //    ask on the minority contract won the old race-to-trigger policy.
      //  • Once locked we ONLY ever look at the locked side.
      let side: TradeSide | null
      let sidePrice: number | null
      if (this.lockedDirection !== null) {
        side = this.lockedDirection
        sidePrice = this.executionPriceForSide(side)
      } else {
        side = majority.side
        sidePrice = side === null ? null : this.executionPriceForSide(side)
      }

      // NO LIVE DATA GUARD: if the live Polymarket CLOB price is unavailable we
      // must NOT trade on stale/modeled/estimated values. Cancel any resting
      // order and HOLD until real prices return. This is the single most
      // important safety rule — the engine never invents a price.
      if (side === null || sidePrice === null) {
        if (this.restingOrder) this.cancelRestingOrder()
        if (!this.paused) this.status = "NO_DATA"
        const diag = this.deps.clobPriceFeed.diagnostics()
        const upAge = diag.upQuoteAgeMs !== null ? `${(diag.upQuoteAgeMs / 1000).toFixed(1)}s old` : "never received"
        const downAge = diag.downQuoteAgeMs !== null ? `${(diag.downQuoteAgeMs / 1000).toFixed(1)}s old` : "never received"
        const tokenInfo = diag.upTokenId
          ? `UP token …${diag.upTokenId.slice(-8)} / DOWN token …${diag.downTokenId?.slice(-8) ?? "none"}`
          : "no token IDs (market discovery still pending)"
        const failInfo = diag.consecutiveFailures > 0
          ? `${diag.consecutiveFailures} consecutive poll failures — last reason: ${diag.lastFailReason || "unknown"}`
          : diag.lastSuccessMs === 0
            ? "no successful poll yet since boot"
            : `last good poll ${((Date.now() - diag.lastSuccessMs) / 1000).toFixed(1)}s ago`
        const validationInfo = this.tickSnapshot === null
          ? `snapshot invalid: ${diag.validationFailReason || "unknown"}`
          : `snapshot confidence ${this.tickSnapshot.confidence} — execution requires MEDIUM or better`
        this.throttledLog(
          `nodata-${this.slotEndMs}-${diag.consecutiveFailures}-${diag.upTokenId?.slice(-8) ?? "noid"}-${this.tickSnapshot?.confidence ?? "none"}`,
          "warn",
          `Standing limit HOLDING: no validated CLOB/BTC-reference majority snapshot — ${validationInfo} | ${tokenInfo} | ${failInfo} | generation ${diag.generation} | majority side is ${side ?? "null"} | endpoint: ${process.env.CLOB_HTTP_HOST ?? "https://clob.polymarket.com"}`,
        )
        this.logWithheld("no-data", `no validated CLOB/BTC-reference majority snapshot — ${validationInfo} | ${failInfo}`)
        return
      }

      // Guardrail band: suppress operation when the tradeable price is outside [min, max].
      if (sidePrice < minPrice || sidePrice > maxPrice) {
        if (this.restingOrder) this.cancelRestingOrder()
        this.status = "OUT_OF_RANGE"
        this.throttledLog(
          `range-${this.slotEndMs}-${side}`,
          "info",
          `Standing limit holding: ${side} $${sidePrice.toFixed(2)} outside band $${minPrice.toFixed(2)}–$${maxPrice.toFixed(2)}`,
        )
        this.logWithheld(
          "out-of-range",
          `${side} $${sidePrice.toFixed(2)} outside guardrail band $${minPrice.toFixed(2)}–$${maxPrice.toFixed(2)}`,
        )
        return
      }

      // Before the direction is locked, if a resting order exists but the
      // majority side flipped, cancel it and re-evaluate on the new side.
      // After lock, the side is fixed so this never fires.
      if (this.restingOrder && this.restingSide !== side) {
        this.throttledLog(
          `flip-${this.slotEndMs}-${side}`,
          "info",
          `Majority side flipped to ${side} — cancelling stale ${this.restingSide} order for re-evaluation`,
        )
        this.cancelRestingOrder()
      }

      if (!this.restingOrder) {
        const mode = this.params.triggerMode

        // Below the trigger: no entry yet. In UPWARD_CROSSING this ARMS the gate
        // so the next upward crossing fires an order. In AT_OR_ABOVE it simply
        // holds (the gate is managed on fill), since that mode only ever fires
        // when the price is at/above the trigger.
        if (sidePrice < triggerPrice) {
          if (mode === "UPWARD_CROSSING") this.readyForTrigger = true
          this.status = this.positions.length ? "FILLED" : "ARMED"
          this.throttledLog(
            `armed-${this.slotEndMs}-${this.positions.length}`,
            "info",
            `Standing limit ${this.positions.length ? "HOLDING" : "ARMED"}: ${side} $${sidePrice.toFixed(2)} < trigger $${triggerPrice.toFixed(2)} — waiting for trigger [${mode}]`,
          )
          return
        }

        // Price is at/above the trigger. The gate must be OPEN to fire.
        //  • UPWARD_CROSSING: gate opens only after the price was below the
        //    trigger (a genuine crossing). If it's closed here, this elevated
        //    price is NOT a fresh crossing, so we hold and wait for a re-cross.
        //  • AT_OR_ABOVE: the gate is opened at arm and re-opened after each
        //    fill, so it fires here whenever price is at/above the trigger.
        if (!this.readyForTrigger) {
          this.status = this.positions.length ? "FILLED" : "ARMED"
          this.throttledLog(
            `waitreset-${this.slotEndMs}-${this.executionCount}`,
            "info",
            `Standing limit holding ${side} — price $${sidePrice.toFixed(2)} ≥ trigger $${triggerPrice.toFixed(2)} but awaiting a fresh upward crossing before the next entry`,
          )
          return
        }

        // Placement-failure cooldown: after a failed submission the trigger is
        // re-armed, but retries are rate-limited so a hard API outage never
        // machine-guns order placements.
        if (Date.now() < this.nextSubmitAllowedMs) {
          this.throttledLog(
            `cooldown-${this.slotEndMs}-${this.nextSubmitAllowedMs}`,
            "info",
            `Standing limit in retry cooldown (${((this.nextSubmitAllowedMs - Date.now()) / 1000).toFixed(1)}s) after a failed placement`,
          )
          this.logWithheld(
            "retry-cooldown",
            `price at/above trigger but submission blocked by retry cooldown (${((this.nextSubmitAllowedMs - Date.now()) / 1000).toFixed(1)}s remaining) after a failed placement`,
          )
          return
        }

        // Fresh trigger crossing — validate market ids and capital, then submit.
        const ids = this.orderIds(side)
        if (!ids) {
          this.status = "WAITING_MARKET"
          this.throttledLog(
            `waiting-${this.slotEndMs}`,
            "warn",
            "Standing limit waiting: Polymarket market for this 5-min slot not listed yet",
          )
          this.logWithheld("no-market", "trigger crossed but the Polymarket market for this 5-min slot is not listed yet")
          return
        }

        // AUTOMATIC COMPOUNDING — size the order NOW, from the CURRENT
        // ledger-authoritative bankroll. In PERCENT mode every prior
        // settlement has already updated the pool, so this order compounds
        // automatically (e.g. pool $100 → win → pool $106 → this order
        // sizes from $106). FIXED_SHARES preserves the legacy behavior.
        const shares = this.computeOrderShares(limitPrice)
        const bankroll = this.deps.getBankroll()
        const pool = bankroll.balance + bankroll.dustReserve
        const required = limitPrice * shares
        if (shares < 1 || required > pool) {
          this.status = "INSUFFICIENT"
          this.throttledLog(
            `insufficient-${this.slotEndMs}-${this.executionCount}`,
            "warn",
            shares < 1
              ? `Standing limit held: pool $${pool.toFixed(2)} cannot afford a single share at $${limitPrice.toFixed(2)} (${this.params.sizingMode})`
              : `Standing limit held: needs $${required.toFixed(2)} but pool is $${pool.toFixed(2)}`,
          )
          this.logWithheld(
            "insufficient-capital",
            `trigger crossed but capital insufficient: needs $${required.toFixed(2)}, pool $${pool.toFixed(2)}`,
          )
          return
        }

        // LAST-INSTANT WINDOW RE-CHECK — the trigger evaluation above and this
        // submission run in the same tick, but a tick can straddle a boundary.
        // Re-checking here guarantees no order is EVER placed outside the
        // final entry window:
        //  • window not open yet (early race) → withhold, keep waiting
        //  • market already settled (late race) → withhold, rollover re-arms
        const lastInstantOpensIn = this.entryWindowOpensInMs()
        if (lastInstantOpensIn !== null && lastInstantOpensIn > 0) {
          this.status = "WINDOW_WAITING"
          logEvent(
            "info",
            `Standing limit: trigger reached but the final entry window has not opened yet �� order withheld (no early entries)`,
          )
          return
        }
        if (lastInstantOpensIn !== null && nowMs() >= this.slotEndMs) {
          this.status = "WINDOW_EXPIRED"
          logEvent(
            "info",
            `Standing limit: trigger reached but the market settled before submission — order withheld (no late entries)`,
          )
          return
        }

        this.status = "TRIGGERED"

        // ---- LATENCY INSTRUMENTATION (stage 1) ----
        // quote age at snapshot + snapshot→decision time, measured from the
        // atomic snapshot this tick captured at its start.
        const snapCapturedAtMs = this.tickSnapshot?.timestampMs ?? this.lastTickStartMs
        const quoteAgeMs = this.tickSnapshot
          ? Math.max(this.tickSnapshot.upAgeMs, this.tickSnapshot.downAgeMs)
          : -1
        const decisionAtMs = Date.now()

        // DIRECTION LOCK — the BTC-reference majority side reached the trigger.
        // From here on the engine ONLY trades this side and ignores the opposite
        // contract for the rest of this 5-minute market. The TRIGGER LOCK
        // freezes the full market identity (generation, market id, both token
        // ids, slot id) and the exact snapshot that fired, so the decision is
        // forensically reconstructible and immune to reconnects/refreshes.
        if (this.lockedDirection === null) {
          this.lockedDirection = side
          this.triggerSnapshot = this.tickSnapshot
          this.triggerLock = {
            generation: this.tickSnapshot?.generation ?? this.deps.clobPriceFeed.generation,
            marketId: ids.marketId,
            upTokenId: this.market?.upTokenId ?? "",
            downTokenId: this.market?.downTokenId ?? "",
            slotEndMs: this.slotEndMs,
            lockedAtMs: Date.now(),
          }
          logEvent(
            "info",
            `Standing limit DIRECTION LOCKED: BTC-reference majority ${side} reached trigger $${triggerPrice.toFixed(2)} (generation ${this.triggerLock.generation}, confidence ${this.tickSnapshot?.confidence ?? "?"}) — ignoring the opposite contract until fill/cancel/slot expiry`,
          )
        }

        logEvent(
          "info",
          `Standing limit TRIGGERED: ${side} (locked) $${sidePrice.toFixed(2)} reached trigger $${triggerPrice.toFixed(2)} — submitting LIMIT BUY ${shares} @ $${limitPrice.toFixed(2)}`,
        )

        // MANDATORY RISK GATE — kill switch, daily loss breaker, notional cap,
        // daily order cap, price/share sanity, expiry guard. A veto holds the
        // order and re-checks next tick (the kill switch veto is terminal
        // until the operator disengages it).
        const verdict = this.deps.risk.checkOrder({
          price: limitPrice,
          shares,
          slotEndMs: this.slotEndMs,
        })
        if (!verdict.ok) {
          // A veto must NEVER masquerade as a healthy "ARMED" state — that
          // made a kill-switch/daily-cap halt invisible on the dashboard and
          // looked exactly like "the engine silently stopped trading".
          this.status = "BLOCKED"
          this.blockedReason = verdict.reason
          this.throttledLog(
            `risk-veto-${this.slotEndMs}-${verdict.reason.slice(0, 40)}`,
            "warn",
            `Standing limit order BLOCKED by risk gate: ${verdict.reason} — engine stays armed and auto-resumes the moment the gate clears`,
          )
          return
        }
        this.blockedReason = null

        // Consume the trigger crossing immediately so a slow placement can
        // never double-submit on the next tick.
        this.readyForTrigger = false
        this.restingSide = side
        // Persist the direction lock BEFORE the network call so a crash
        // mid-placement can never re-race the opposite side after restart.
        this.persistState()
        // ---- LATENCY (stage 2): decision → placeOrder start ----
        const submitStartMs = Date.now()
        let placedOrder: OpenOrder
        try {
          // Timeout-bounded: a hung placement resolves as an AMBIGUOUS failure
          // (handled below with exchange-state verification + adoption), never
          // as a permanently wedged tick.
          placedOrder = await withTimeout(
            this.executor.placeOrder({
              marketId: ids.marketId,
              tokenId: ids.tokenId,
              side,
              price: limitPrice,
              shares,
              phase: "WAITING",
              tif: "GTC",
              expireAtMs: null,
            }),
            EXEC_CALL_TIMEOUT_MS,
            "placeOrder",
          )
        } catch (e) {
          await this.handlePlacementFailure(side, ids, e)
          return
        }
        // ---- LATENCY (stage 3): exchange ack received ----
        const ackMs = Date.now()
        // GHOST-TICK GUARD after the placement await: if the epoch moved while
        // the order was in flight (busy-watchdog fired / rollover / cancel),
        // this tick's world is gone but the order IS live on the exchange.
        // Do NOT adopt it into the new world — cancel it and abandon.
        if (this.tickEpoch !== myEpoch) {
          logEvent(
            "warn",
            `Standing limit GHOST TICK abandoned after placement: epoch moved while placeOrder was in flight — cancelling orphan order ${placedOrder.exchangeOrderId} instead of adopting it into a changed market`,
          )
          insertOrderLog({
            mode: this.deps.getMode(),
            event: "CANCELLED",
            marketId: ids.marketId,
            tokenId: ids.tokenId,
            exchangeOrderId: placedOrder.exchangeOrderId,
            side,
            price: limitPrice,
            shares,
            phase: "WAITING",
            detail: "ghost-tick guard: epoch changed during placement — orphan order cancelled, no state adopted",
          })
          try {
            await withTimeout(this.executor.cancelOrder(placedOrder), EXEC_CALL_TIMEOUT_MS, "cancelOrder")
          } catch {
            /* reconciler net catches an uncancellable orphan */
          }
          return
        }
        this.restingOrder = placedOrder
        this.status = "RESTING"
        this.lastThrottleKey = ""
        this.persistState()
        logEvent(
          "info",
          `Standing limit RESTING: LIMIT BUY ${shares} ${side} @ $${limitPrice.toFixed(2)} on ${ids.marketId}`,
        )
        insertOrderLog({
          mode: this.deps.getMode(),
          event: "SUBMITTED",
          marketId: ids.marketId,
          tokenId: ids.tokenId,
          exchangeOrderId: this.restingOrder.exchangeOrderId,
          side,
          price: limitPrice,
          shares,
          phase: "WAITING",
          detail: `standing-limit trigger-buy (trigger $${triggerPrice.toFixed(2)}${this.lockedDirection ? ", locked" : ""})`,
        })
        notify(
          "orders",
          "ORDER TRIGGERED + SUBMITTED",
          `BUY ${shares} ${side} @ $${limitPrice.toFixed(2)}\nTrigger: $${triggerPrice.toFixed(2)}\nMarket: ${ids.marketId}`,
        )

        // The buy was submitted because the ask reached the trigger (≤ target),
        // so it is marketable now. Check the fill immediately instead of waiting
        // a full poll tick, otherwise a fast-moving ask can climb past target.
        // This await stays ON the hot path — it IS the execution.
        const immediate = await withTimeout(this.executor.checkFill(this.restingOrder), EXEC_CALL_TIMEOUT_MS, "checkFill")
        // ---- LATENCY (stage 4): immediate fill check done — record breakdown ----
        const fillCheckDoneMs = Date.now()
        this.lastExecutionLatency = {
          quoteAgeMs,
          decisionMs: Math.max(0, decisionAtMs - snapCapturedAtMs),
          preSubmitMs: Math.max(0, submitStartMs - decisionAtMs),
          submitMs: Math.max(0, ackMs - submitStartMs),
          fillCheckMs: Math.max(0, fillCheckDoneMs - ackMs),
          totalMs: Math.max(0, ackMs - snapCapturedAtMs),
          atMs: submitStartMs,
        }
        logEvent(
          "info",
          `Standing limit EXECUTION LATENCY: quote age ${quoteAgeMs}ms | snapshot→decision ${this.lastExecutionLatency.decisionMs}ms | pre-submit ${this.lastExecutionLatency.preSubmitMs}ms | submit→ack ${this.lastExecutionLatency.submitMs}ms | fill-check ${this.lastExecutionLatency.fillCheckMs}ms | total snapshot→ack ${this.lastExecutionLatency.totalMs}ms`,
        )
        // Epoch guard after the fill-check await: on mismatch, do not process
        // the fill here — the reconciler/order-events layer owns recovery.
        if (this.tickEpoch !== myEpoch) return
        if (immediate) this.onFill(immediate.order, immediate.filledPrice)
      } else {
        // HOT-PATH ISOLATION: the resting-order fill poll is a slow REST call
        // (up to EXEC_CALL_TIMEOUT_MS). Running it inline starved trigger
        // evaluation whenever an order was resting. It now runs as a
        // single-flight BACKGROUND task — the tick returns immediately and
        // stays responsive for rollover/settlement/status work.
        void this.pollRestingFill(myEpoch)

        // Explain WHY a resting order isn't filling: it's a maker limit sitting
        // below the market, so it only fills once the ask drops to the limit.
        // Reads THIS TICK's snapshot — cheap, so it stays on the tick.
        const restingSide = this.restingOrder.side
        const ask = this.executionPriceForSide(restingSide)
        if (ask !== null && ask > this.restingOrder.price + 1e-9) {
          this.throttledLog(
            `resting-below-${restingSide}-${this.restingOrder.price}`,
            "info",
            `Standing limit RESTING below market: LIMIT BUY ${restingSide} @ $${this.restingOrder.price.toFixed(2)} — live ask $${ask.toFixed(2)} is higher, so the maker order waits for the price to fall to the limit before it fills`,
          )
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.throttledLog(`err-${msg}`, "warn", `Standing limit tick error: ${msg}`)
    } finally {
      this.busy = false
      this.lastTickCompletedMs = Date.now()
    }
  }

  /**
   * Single-flight BACKGROUND fill poll for the resting order (moved off the
   * tick hot path). Epoch-guarded at every resume point: if the world changed
   * while a REST call was in flight (rollover, cancel, busy-watchdog), the
   * poll abandons without touching state. The reconciler + settlement nets
   * remain the outer safety layers, exactly as before.
   */
  private async pollRestingFill(myEpoch: number): Promise<void> {
    if (this.fillPollInFlight) return
    if (!this.executor || !this.restingOrder) return
    this.fillPollInFlight = true
    try {
      const fill = await withTimeout(this.executor.checkFill(this.restingOrder), EXEC_CALL_TIMEOUT_MS, "checkFill")
      if (this.tickEpoch !== myEpoch || !this.restingOrder) return // world changed mid-poll
      if (fill) {
        this.onFill(fill.order, fill.filledPrice)
        return
      }
      // STUCK-RESTING GUARD: every 15s verify the order still exists on
      // the exchange. If it was cancelled externally (manual cancel, an
      // exchange purge, a cancelAll from another subsystem) the engine
      // would otherwise stay RESTING forever against a dead order.
      const nowMs = Date.now()
      if (this.executor.getOrderState && nowMs - this.lastOrderStateCheckMs > 15_000) {
        this.lastOrderStateCheckMs = nowMs
        const state = await withTimeout(
          this.executor.getOrderState(this.restingOrder),
          EXEC_CALL_TIMEOUT_MS,
          "getOrderState",
        )
        if (this.tickEpoch !== myEpoch || !this.restingOrder) return // world changed mid-poll
        if (state === "DEAD") {
          const dead = this.restingOrder
          this.restingOrder = null
          this.restingSide = null
          this.readyForTrigger = true
          this.nextSubmitAllowedMs = nowMs + 2_000
          this.status = "ARMED"
          this.persistState()
          logEvent(
            "warn",
            `Standing limit: resting order ${dead.exchangeOrderId} was cancelled EXTERNALLY — cleared and trigger re-armed`,
          )
          insertOrderLog({
            mode: this.deps.getMode(),
            event: "CANCELLED",
            marketId: dead.marketId,
            tokenId: dead.tokenId,
            exchangeOrderId: dead.exchangeOrderId,
            side: dead.side,
            price: dead.price,
            shares: dead.shares,
            phase: "WAITING",
            detail: "externally cancelled (detected by exchange state poll) — trigger re-armed",
          })
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.throttledLog(`fillpoll-${msg}`, "warn", `Standing limit fill poll error: ${msg}`)
    } finally {
      this.fillPollInFlight = false
    }
  }

  /**
   * A placeOrder call threw. The order may or may not have been accepted
   * (e.g. a response timeout AFTER exchange acceptance), so:
   *   1. UNKNOWN-STATE PROTECTION: scan the account's live open orders for a
   *      match (same token, side, ~same price) and ADOPT it instead of
   *      re-placing — a blind retry would create a duplicate live order.
   *   2. Only when confirmably absent, re-open the trigger gate with a retry
   *      cooldown so the window is never silently dead after one bad call.
   */
  private async handlePlacementFailure(side: TradeSide, ids: { marketId: string; tokenId: string }, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logEvent("error", `Standing limit placement FAILED: ${msg} — verifying exchange state before any retry`)
    insertOrderLog({
      mode: this.deps.getMode(),
      event: "ERROR",
      marketId: ids.marketId,
      tokenId: ids.tokenId,
      side,
      price: this.params?.limitPrice,
      shares: this.params?.shares,
      phase: "WAITING",
      detail: `placement failed: ${msg.slice(0, 250)}`,
    })
    // VERIFY WITH RETRIES: a single failed verification read must never be
    // treated as "confirmed absent" — if the network is degraded, the lost
    // order may well be live, and a blind re-place would DUPLICATE it. Try
    // the adoption scan up to 3 times (2s apart) before deciding.
    let verified = false
    if (this.executor?.getOpenOrdersLive && this.params) {
      for (let attempt = 1; attempt <= 3 && !verified; attempt++) {
        try {
          const open = await withTimeout(this.executor.getOpenOrdersLive(), EXEC_CALL_TIMEOUT_MS, "getOpenOrdersLive")
          verified = true
          const match = open.find(
            (o) =>
              o.assetId === ids.tokenId &&
              o.side.toUpperCase() === "BUY" &&
              Math.abs(o.price - this.params!.limitPrice) < 0.005,
          )
          if (match) {
            this.restingOrder = {
              clientOrderId: `adopted-${match.id}`,
              exchangeOrderId: match.id,
              marketId: ids.marketId,
              tokenId: ids.tokenId,
              side,
              price: this.params.limitPrice,
              shares: this.params.shares,
              placedAtMs: match.createdAtMs || Date.now(),
              phase: "WAITING",
            }
            this.restingSide = side
            this.status = "RESTING"
            this.persistState()
            logEvent(
              "warn",
              `Standing limit: placement response was lost but the order IS live on the exchange (${match.id}) — ADOPTED it, no duplicate placed`,
            )
            return
          }
        } catch {
          if (attempt < 3) await new Promise((r) => setTimeout(r, 2_000))
        }
      }
    } else {
      // No live order listing available (paper mode) — the simulated exchange
      // cannot hold a lost order, so absence is structurally guaranteed.
      verified = true
    }

    // Re-open the gate with a cooldown sized to our confidence. Direction
    // lock is retained — the race was legitimately won.
    this.restingSide = null
    this.readyForTrigger = true
    if (verified) {
      this.nextSubmitAllowedMs = Date.now() + 5_000
      logEvent("warn", "Standing limit: order confirmed NOT on the book — trigger re-armed with a 5s retry cooldown")
    } else {
      // UNVERIFIABLE: the exchange could not be read 3x. The order MAY be
      // live. Use a 60s cooldown so the next reconciler cycle (60s) can flag
      // any untracked order before a retry could possibly duplicate it.
      this.nextSubmitAllowedMs = Date.now() + 60_000
      logEvent(
        "error",
        "Standing limit: placement state UNVERIFIABLE after 3 attempts — the lost order may be live. Retry delayed 60s for the reconciler cross-check; check the account if this repeats",
      )
    }
    this.status = "ARMED"
    this.persistState()
  }

  /**
   * PERMANENT DIRECTION AUDIT record persisted with every trade: the exact
   * validated snapshot that fired the trigger (generation, sequence, both
   * quotes, sources, latency, ages, confidence), the frozen trigger-lock
   * identity, the trigger parameters, and the majority computation. Falls
   * back to the current tick snapshot if the trigger snapshot is unavailable
   * (e.g. fill confirmed after a restart).
   */
  private buildFeedAudit(order: OpenOrder) {
    const snap = this.triggerSnapshot ?? this.tickSnapshot
    const lock = this.triggerLock
    const refTick = this.deps.spotFeed.latest
    const spotAgeMs = refTick ? Date.now() - refTick.tsMs : null
    const spot = refTick && spotAgeMs !== null && spotAgeMs <= SPOT_STALE_MS ? refTick.price : null
    const btcDirection =
      this.strike !== null && spot !== null
        ? spot > this.strike
          ? "UP"
          : spot < this.strike
            ? "DOWN"
            : null
        : null
    const upPct = snap ? Math.round(snap.up.price * 100) : null
    const downPct = snap ? Math.round(snap.down.price * 100) : null
    return {
      sideSelectionBasis: "BTC_REFERENCE_MAJORITY",
      generation: snap?.generation ?? lock?.generation ?? null,
      sequence: snap?.sequence ?? null,
      snapshotAtMs: snap?.timestampMs ?? null,
      triggerPrice: this.params?.triggerPrice ?? null,
      triggerMode: this.params?.triggerMode ?? null,
      limitPrice: this.params?.limitPrice ?? null,
      winningSide: order.side,
      btcReference: {
        strike: this.strike,
        spot,
        direction: btcDirection,
        spotAgeMs,
      },
      majority: snap
        ? { side: btcDirection, upPct, downPct }
        : null,
      quotes: snap
        ? {
            up: { price: snap.up.price, source: snap.up.source, ageMs: snap.upAgeMs, latencyMs: snap.up.latencyMs },
            down: { price: snap.down.price, source: snap.down.source, ageMs: snap.downAgeMs, latencyMs: snap.down.latencyMs },
          }
        : null,
      wsFreshMs: snap?.wsFreshMs ?? null,
      restFreshMs: snap?.restFreshMs ?? null,
      confidence: snap?.confidence ?? null,
      marketId: order.marketId,
      slotEndMs: this.slotEndMs,
      lock: lock
        ? { generation: lock.generation, marketId: lock.marketId, upTokenId: lock.upTokenId, downTokenId: lock.downTokenId, lockedAtMs: lock.lockedAtMs }
        : null,
    }
  }

  private onFill(order: OpenOrder, filledPrice: number) {
    const cost = Math.round(order.shares * filledPrice * 10000) / 10000
    const bankroll = this.deps.getBankroll()
    bankroll.debitFixed(cost)
    const balanceAfter = bankroll.balance + bankroll.dustReserve

    // PARTIAL-FILL TRANSPARENCY (Phase 5): the executor reduces order.shares
    // to the matched count when the remainder was cancelled (correct exchange
    // behavior) — but the ledger and Telegram used to show the reduced number
    // with NO explanation, making it look like the engine changed the size on
    // its own (e.g. "Fixed Shares 7 became 3"). Detect the reduction against
    // the sizing computed at submit and record it PERMANENTLY everywhere.
    const requestedShares = this.lastSizing?.effectiveShares ?? order.shares
    const partialFill =
      order.shares < requestedShares
        ? { requested: requestedShares, filled: order.shares, remainderCancelled: requestedShares - order.shares }
        : null
    if (partialFill) {
      logEvent(
        "warn",
        `Standing limit PARTIAL FILL: requested ${partialFill.requested} shares, only ${partialFill.filled} matched — remainder of ${partialFill.remainderCancelled} was cancelled by the exchange, NOT resized by the engine`,
      )
      insertOrderLog({
        mode: this.deps.getMode(),
        event: "FILLED",
        marketId: order.marketId,
        tokenId: order.tokenId,
        exchangeOrderId: order.exchangeOrderId,
        side: order.side,
        price: filledPrice,
        shares: order.shares,
        phase: "WAITING",
        detail: `PARTIAL_FILL: requested ${partialFill.requested}, filled ${partialFill.filled}, remainder ${partialFill.remainderCancelled} cancelled at the exchange`,
      })
    }

    notify(
      "orders",
      "ORDER FILLED",
      `${order.shares} ${order.side} @ $${filledPrice.toFixed(2)} = $${cost.toFixed(2)}${partialFill ? `\nPARTIAL: ${partialFill.requested} requested, ${partialFill.filled} filled (remainder cancelled by exchange)` : ""}\nMarket: ${order.marketId}`,
    )

    const tradeUid = randomUUID()
    // Persist a ledger row IMMEDIATELY (status OPEN) so the execution shows up
    // in the transaction history the instant it fills — never waiting for
    // market resolution. It is settled in place at slot rollover.
    let tradeId: number | null = null
    try {
      tradeId = openTrade({
        marketId: order.marketId,
        slotEndMs: this.slotEndMs,
        side: order.side,
        price: filledPrice,
        shares: order.shares,
        cost,
        balanceAfter,
        mode: this.deps.getMode(),
        orderId: order.exchangeOrderId,
        tradeUid,
        explanation: JSON.stringify({
          entry: `standing limit order: BTC-reference majority ${order.side} reached trigger $${this.params?.triggerPrice.toFixed(2) ?? "?"} [${this.params?.triggerMode ?? "?"}], LIMIT BUY placed at target $${this.params?.limitPrice.toFixed(2) ?? "?"} and filled at $${filledPrice.toFixed(2)}`,
          sideSelection: `direction locked to ${this.lockedDirection ?? order.side} — BTC reference was ${this.lockedDirection ?? order.side} versus the captured candle strike; opposite-side trigger touches were ignored`,
          costCalc: `${order.shares} shares × $${filledPrice.toFixed(4)} = $${cost.toFixed(4)} debited from the pool`,
          // PERMANENT DIRECTION AUDIT — the exact validated feed snapshot that
          // fired the trigger, plus the frozen lock identity. Forensic
          // investigations never need to guess what the engine saw.
          feedAudit: this.buildFeedAudit(order),
          // PERMANENT LATENCY AUDIT — quote→decision→submit→ack breakdown of
          // the submission that produced this fill (null for adopted orders).
          executionLatency: this.lastExecutionLatency,
          // PERMANENT SIZING AUDIT (Phase 5) — proves whether the booked share
          // count matches what was requested; partialFill explains any gap
          // (remainder cancelled at the exchange, never resized by the engine).
          sizing: this.lastSizing,
          ...(partialFill ? { partialFill } : {}),
        }),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logEvent("warn", `Standing limit: failed to open ledger row: ${msg}`)
    }

    const filledAtMs = Date.now()
    this.positions.push({
      side: order.side,
      price: filledPrice,
      shares: order.shares,
      cost,
      marketId: order.marketId,
      slotEndMs: this.slotEndMs,
      tradeId,
      orderId: order.exchangeOrderId,
      tradeUid,
      filledAtMs,
    })

    // Direction is normally locked at trigger time (the race winner). This is a
    // safety fallback in case a fill somehow arrives before the lock was set.
    if (this.lockedDirection === null) this.lockedDirection = order.side

    this.restingOrder = null
    this.restingSide = null
    // ORDER FILLED — one of the three release conditions for the trigger lock.
    // The DIRECTION stays locked for the rest of the market (one order per
    // window), but the frozen-identity lock has served its purpose.
    this.triggerLock = null
    this.executionCount += 1
    this.lastExecutedAtMs = filledAtMs
    this.status = "FILLED"
    // ONE ORDER PER WINDOW — the single order for this 5-minute market has now
    // filled. Close the trigger gate and mark the window complete so the engine
    // places NO further orders until the slot rolls over. The position is held
    // and marked live until resolution.
    this.readyForTrigger = false
    this.windowFilled = true
    this.persistState()
    logEvent(
      "trade",
      `Standing limit FILLED (#${this.executionCount}): ${order.side} ${order.shares} @ $${filledPrice.toFixed(2)} (cost $${cost.toFixed(2)}) — ledger #${tradeId ?? "?"}`,
    )
    insertOrderLog({
      mode: this.deps.getMode(),
      event: "FILLED",
      marketId: order.marketId,
      tokenId: order.tokenId,
      exchangeOrderId: order.exchangeOrderId,
      side: order.side,
      price: filledPrice,
      shares: order.shares,
      phase: "WAITING",
      detail: `standing-limit fill #${this.executionCount}, cost $${cost.toFixed(4)}, trade ${tradeUid.slice(0, 8)}`,
    })
  }

  /**
   * Refresh the live mark + unrealized PnL on every open ledger row using the
   * live Polymarket best-ask. When live data is unavailable we DO NOT write a
   * modeled/estimated mark — the last real mark is left untouched until real
   * prices return.
   */
  private refreshOpenMarks() {
    for (const pos of this.positions) {
      if (pos.tradeId === null) continue
      const mark = this.displayMarkForSide(pos.side)
      if (mark === null) continue
      const unrealized = Math.round((pos.shares * mark - pos.cost) * 10000) / 10000
      updateOpenTradeMark(pos.tradeId, mark, unrealized)
    }
  }

  private async rolloverSlot(newSlotEnd: number) {
    // SLOT BOUNDARY = epoch bump: any tick still suspended on an await from
    // the PREVIOUS slot abandons at its next resume point. The tick that
    // called this rollover re-syncs its own epoch and continues legitimately.
    this.bumpEpoch("rollover")
    // New slot → fresh withhold log throttle (one row per reason per slot).
    this.loggedWithholds.clear()
    this.cancelRestingOrder()

    const positions = this.positions
    this.positions = []
    if (positions.length > 0) {
      // Official Polymarket resolution is the single source of truth in BOTH
      // paper and live modes. Capture the strict spot fallback SYNCHRONOUSLY
      // now, before `this.strike` is cleared below — settleOfficial runs in the
      // background and would otherwise read a null strike. The fallback is a
      // last resort only; the official outcome is always preferred.
      const fallback = this.computeSpotFallback()
      // BUG #5: mark these lots pending so PERCENT compounding in the NEW slot
      // cannot size from a stale bankroll before settleOfficial credits payout.
      for (const p of positions) this.pendingSettlementUids.add(p.tradeUid)
      void this.settleOfficial(positions, fallback)
    }

    this.slotEndMs = newSlotEnd
    this.strike = null
    // New market → SLOT EXPIRY releases the trigger lock, resets the direction
    // lock, clears the one-shot flag so the new window can place its single
    // order, and re-inits the trigger gate per mode (closed for UPWARD_CROSSING
    // so an already-elevated price waits for a fresh crossing; open for
    // AT_OR_ABOVE).
    this.lockedDirection = null
    this.triggerLock = null
    this.triggerSnapshot = null
    this.tickSnapshot = null
    this.windowFilled = false
    this.readyForTrigger = this.params?.triggerMode === "AT_OR_ABOVE"
    // Point the feed at the new slot. If the next market was already prefetched
    // (the normal case) install its tokens SYNCHRONOUSLY so there is no null-
    // quote gap at the boundary; only clear when no cached market exists yet, so
    // the SLO never triggers on the expired slot's prices during the gap.
    this.market = this.deps.discovery.peek(newSlotEnd)
    if (this.market && this.market.slotEndMs === newSlotEnd) {
      this.deps.clobPriceFeed.setTokenIds(this.market.upTokenId, this.market.downTokenId)
    } else {
      this.deps.clobPriceFeed.clearTokenIds()
    }
    this.earlyResolutionChecking = false
    this.lastResolutionCheckMs = 0
    this.nextSubmitAllowedMs = 0
    this.lastOrderStateCheckMs = 0
    this.status = this.paused ? "PAUSED" : "REFRESHING"
    this.persistState()
    void this.deps.discovery.resolve(newSlotEnd).then((m) => {
      if (m && m.slotEndMs === this.slotEndMs) {
        this.market = m
        this.deps.clobPriceFeed.setTokenIds(m.upTokenId, m.downTokenId)
        logEvent("info", `Standing limit: new market resolved — ${m.slug}, CLOB feed updated, direction lock reset`)
      }
    }).catch((e) => {
      // CERTIFICATION FIX (Phase 6): this was an ORPHANED PROMISE — a Gamma
      // outage at the slot boundary rejected here with no .catch, producing an
      // unhandled promise rejection on EVERY rollover for the duration of the
      // outage (soak test reproduced 50 in a row). The engine keeps running on
      // the peeked/cached market; the per-tick refreshMarket path retries
      // discovery until Gamma recovers, so logging is the correct response.
      logEvent(
        "warn",
        `Standing limit: market resolve failed for slot ${newSlotEnd} (${e instanceof Error ? e.message : String(e)}) — continuing on prefetched market; discovery will retry`,
      )
    })
  }

  /**
   * Poll Gamma for early market resolution while holding positions.
   * Polymarket 5-min BTC markets resolve via Chainlink at candle close — the
   * `closed` flag on the Gamma record flips within seconds of resolution.
   * This runs every tick (throttled to 5 s) while holding a position and
   * settles the instant the market closes, without waiting for the 5-minute
   * clock boundary.
   */
  private async checkEarlyResolution() {
    if (this.earlyResolutionChecking) return
    if (this.positions.length === 0) return
    const now = Date.now()
    if (now - this.lastResolutionCheckMs < 5_000) return
    this.lastResolutionCheckMs = now
    this.earlyResolutionChecking = true
    try {
      const m = await this.deps.discovery.refreshMarket(this.slotEndMs)
      if (!m) return
      if (!m.closed && m.active) return // market still running

      // Market is closed or inactive — query the official winner.
      const winner = await this.deps.discovery.fetchResolution(this.slotEndMs)
      if (winner !== null && this.positions.length > 0) {
        const positions = this.positions
        this.positions = []
        logEvent(
          "info",
          `Standing limit: early market resolution detected (${m.slug}) — settling ${positions.length} position(s), winner=${winner}`,
        )
        for (const pos of positions) this.recordSettlement(pos, winner, "official-early")

        // Advance to the current slot so the engine re-arms on the NEXT active
        // market rather than spinning on the now-closed one.
        const nextSlot = currentSlotEndMs()
        if (nextSlot !== this.slotEndMs) {
          await this.rolloverSlot(nextSlot)
        } else {
          // Same clock slot but market closed early. Reset the direction lock,
          // release the trigger lock (the market it referenced has settled),
          // clear the one-shot flag, and re-init the trigger gate per mode so
          // the next candle starts fresh (windowFilled must not leak into the
          // remainder of the slot after the market it applied to has settled).
          this.lockedDirection = null
          this.triggerLock = null
          this.triggerSnapshot = null
          this.windowFilled = false
          this.readyForTrigger = this.params?.triggerMode === "AT_OR_ABOVE"
          this.status = this.paused ? "PAUSED" : "ARMED"
          this.persistState()
        }
      }
    } finally {
      this.earlyResolutionChecking = false
    }
  }

  /**
   * Resolve and settle a slot's positions against the OFFICIAL Polymarket
   * outcome (Chainlink-resolved), in BOTH paper and live modes.
   *
   * Resolution order — never fabricates a win/loss:
   *   1. Poll the official Gamma resolution with backoff.
   *   2. If still unavailable, use the STRICT spot fallback (fresh tick +
   *      captured strike + decisive margin) supplied by the caller.
   *   3. If neither is reliable, settle SCRATCH (cost refunded, zero PnL) so a
   *      trade is never booked as a loss on unverified data.
   */
  private async settleOfficial(positions: FilledLot[], fallbackWinner: TradeSide | null) {
    const slotEndMs = positions[0].slotEndMs
    let winner: TradeSide | null = null
    try {
      for (let attempt = 0; attempt < RESOLUTION_ATTEMPTS && winner === null; attempt++) {
        winner = await this.deps.discovery.fetchResolution(slotEndMs)
        if (winner === null) await new Promise((r) => setTimeout(r, RESOLUTION_POLL_MS))
      }
    } catch (e) {
      logEvent(
        "error",
        `[settlement] official resolution poll crashed for slot ${slotEndMs}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    if (winner !== null) {
      for (const pos of positions) this.recordSettlement(pos, winner, "official")
      return
    }
    if (fallbackWinner !== null) {
      logEvent(
        "warn",
        `[settlement] official resolution unavailable for slot ${slotEndMs} after ${RESOLUTION_ATTEMPTS} attempts — using strict spot fallback winner=${fallbackWinner}`,
      )
      for (const pos of positions) this.recordSettlement(pos, fallbackWinner, "spot-fallback")
      this.scheduleSoftSettleRecheck(slotEndMs, "spot-fallback")
      return
    }
    logEvent(
      "error",
      `[settlement] CRITICAL: no official resolution and no reliable spot fallback for slot ${slotEndMs} — settling ${positions.length} position(s) as SCRATCH (cost refunded) to avoid a fabricated win/loss`,
    )
    for (const pos of positions) this.recordSettlement(pos, null, "scratch")
    this.scheduleSoftSettleRecheck(slotEndMs, "scratch")
  }

  /**
   * A settle that did NOT use the official resolution (spot-fallback or
   * SCRATCH) is provisional by nature. Schedule a one-shot verifier sweep
   * 5 minutes later — by then Gamma has virtually always published — so a
   * wrong fallback or an unnecessary SCRATCH is upgraded to the true
   * WIN/LOSS within minutes instead of waiting for the periodic sweep to
   * reach it. unref'd; never keeps the process alive; failures only log.
   */
  private scheduleSoftSettleRecheck(slotEndMs: number, kind: string) {
    const t = setTimeout(() => {
      logEvent("info", `[settlement] running priority re-verification for ${kind}-settled slot ${slotEndMs}`)
      void verifySettlements(this.deps.getMode(), {
        creditWallet: (usdDelta) => this.executor?.creditSettlement?.(usdDelta),
      }).catch((e) => logEvent("warn", `[settlement] priority re-verification failed: ${e instanceof Error ? e.message : String(e)}`))
    }, 5 * 60_000)
    if (typeof t === "object" && "unref" in t) t.unref()
  }

  /**
   * Strict, fail-safe spot winner for use ONLY when the official resolution is
   * unavailable. Returns null (→ SCRATCH) unless there is a FRESH Chainlink
   * tick, a captured strike, and a decisive move. Never guesses a near-the-
   * money candle or settles off a stale/zero price — that was the root cause of
   * the intermittent won-but-booked-loss bug.
   */
  private computeSpotFallback(): TradeSide | null {
    const tick = this.deps.spotFeed.latest
    if (!tick || !Number.isFinite(tick.price) || tick.price <= 0) return null
    if (Date.now() - tick.tsMs > SPOT_STALE_MS) return null
    if (this.strike === null) return null
    const margin = tick.price - this.strike
    if (Math.abs(margin) < FALLBACK_MIN_MARGIN_USD) return null
    return margin >= 0 ? "UP" : "DOWN"
  }

  /**
   * Commit the final result for one lot. `winner === null` means SCRATCH (no
   * reliable resolution): the entry cost is refunded and PnL is zero, so a
   * trade is never recorded as a loss on unverified data. Idempotent per
   * tradeUid so the early-resolution and rollover paths can't double-settle.
   */
  private recordSettlement(pos: FilledLot, winner: TradeSide | null, source: string) {
    if (this.settledUids.has(pos.tradeUid)) {
      logEvent("warn", `[settlement] duplicate settle suppressed for ${pos.tradeUid} (${pos.marketId})`)
      return
    }
    this.settledUids.add(pos.tradeUid)
    if (this.settledUids.size > 256) {
      // Bound the guard set; Sets preserve insertion order so keep the newest.
      this.settledUids = new Set([...this.settledUids].slice(-128))
    }

    const isScratch = winner === null
    const won = !isScratch && pos.side === winner
    const result: "WIN" | "LOSS" | "SCRATCH" = isScratch ? "SCRATCH" : won ? "WIN" : "LOSS"
    // The pool was debited `cost` on fill. WIN pays $1/share; LOSS pays 0;
    // SCRATCH refunds the cost so the slot nets exactly zero.
    const payout = isScratch ? pos.cost : won ? pos.shares : 0
    const pnl = isScratch ? 0 : Math.round((payout - pos.cost) * 10000) / 10000
    const markPrice = isScratch ? pos.price : won ? 1 : 0

    // Permanent audit record persisted with the trade (merged into the open
    // explanation written at fill time).
    const settleExplanation = JSON.stringify({
      settlement: isScratch
        ? `SCRATCH — no reliable market resolution (source: ${source}); the entry cost was refunded so the slot nets exactly zero`
        : won
          ? `WIN — bet ${pos.side}, official winner ${winner} (source: ${source}); each of the ${pos.shares} shares paid out $1.00`
          : `LOSS ��� bet ${pos.side}, official winner ${winner} (source: ${source}); the ${pos.shares} shares expired worthless`,
      resolvedWinner: winner,
      resolutionSource: source,
      pnlCalc: isScratch
        ? `cost $${pos.cost.toFixed(4)} refunded; realized PnL $0.0000`
        : `payout $${payout.toFixed(4)} (${won ? `${pos.shares} shares × $1.00` : "0 — losing side"}) − cost $${pos.cost.toFixed(4)} = ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`,
    })

    // Settle the SAME ledger row opened on fill (read-your-writes) so history
    // transitions OPEN → WIN/LOSS/SCRATCH in place. The DB update is the
    // idempotency AUTHORITY: it only touches rows still OPEN, and the bankroll
    // is credited ONLY when this process actually settled the row. Crediting
    // before checking (the old order) could double-pay the pool if the row had
    // already been settled by another path (e.g. boot-time orphan recovery).
    const bankroll = this.deps.getBankroll()
    // ACCOUNTING INVARIANT INPUT: pool total the instant before the credit.
    const openingTotal = bankroll.balance + bankroll.dustReserve
    let credited = false
    if (pos.tradeId !== null) {
      const updated = settleTrade({ id: pos.tradeId, result, pnl, balanceAfter: 0, markPrice, explanation: settleExplanation })
      if (updated === 0) {
        logEvent("warn", `[settlement] ledger row #${pos.tradeId} was already settled — bankroll credit skipped (no double-pay)`)
        return
      }
      bankroll.settle(payout)
      credited = true
      // Stamp the row with the true post-credit balance.
      const balanceNow = bankroll.balance + bankroll.dustReserve
      try {
        // settleTrade only updates OPEN rows; write balance_after directly.
        updateSettledBalance(pos.tradeId, balanceNow)
      } catch {
        /* display-only field — never crash settlement */
      }
    } else {
      bankroll.settle(payout)
      credited = true
      insertTrade({
        marketId: pos.marketId,
        slotEndMs: pos.slotEndMs,
        side: pos.side,
        price: pos.price,
        shares: pos.shares,
        cost: pos.cost,
        result,
        pnl,
        balanceAfter: bankroll.balance + bankroll.dustReserve,
        dustSaved: 0,
        mode: this.deps.getMode(),
        explanation: settleExplanation,
      })
    }
    const balanceAfter = bankroll.balance + bankroll.dustReserve

    // ---- ACCOUNTING INVARIANT (Phase 4): closing = opening + payout ----
    // The entry cost was debited at fill time, so at settlement the pool must
    // move by EXACTLY the payout. Any drift means a double-credit, a missed
    // credit, or an out-of-band balance write. CRITICAL + permanent order_log
    // row on violation; never blocks the settlement itself.
    if (credited) {
      const expectedClosing = Math.round((openingTotal + payout) * 10000) / 10000
      const invariantError = Math.abs(balanceAfter - expectedClosing)
      if (invariantError > 0.01) {
        const detail =
          `ACCOUNTING_INVARIANT_VIOLATION trade_uid=${pos.tradeUid} opening $${openingTotal.toFixed(4)} + payout $${payout.toFixed(4)} ` +
          `= expected $${expectedClosing.toFixed(4)} but closing is $${balanceAfter.toFixed(4)} (drift $${invariantError.toFixed(4)})`
        logEvent("error", `[settlement] CRITICAL: ${detail}`)
        insertOrderLog({
          mode: this.deps.getMode(),
          event: "ERROR",
          marketId: pos.marketId,
          side: pos.side,
          price: pos.price,
          shares: pos.shares,
          detail,
        })
      }
    }

    // PAPER_V1: mirror the payout into the simulated wallet. The wallet was
    // debited on fill; without this credit it drains monotonically over a long
    // session until orders are rejected for "not enough balance".
    if (credited && payout > 0) {
      try {
        this.executor?.creditSettlement?.(payout)
      } catch {
        /* wallet mirror must never crash settlement */
      }
    }

    // Immutable winning token id (best-effort from the cached market record).
    const mkt = this.deps.discovery.peek(pos.slotEndMs)
    const winningTokenId = isScratch || !mkt ? null : winner === "UP" ? mkt.upTokenId : mkt.downTokenId

    // Structured per-trade settlement audit line — the single place to debug a
    // win/loss classification. Contains every input to the decision.
    logEvent(
      "trade",
      `[settlement] ${JSON.stringify({
        marketId: pos.marketId,
        slotEndMs: pos.slotEndMs,
        tradeId: pos.tradeId,
        tradeUid: pos.tradeUid,
        betSide: pos.side,
        entryPrice: pos.price,
        shares: pos.shares,
        cost: Math.round(pos.cost * 10000) / 10000,
        resolvedWinner: winner,
        winningTokenId,
        result,
        source,
        settledAtMs: Date.now(),
        pnl,
        balanceAfter: Math.round(balanceAfter * 10000) / 10000,
        reason: isScratch
          ? "no reliable resolution — cost refunded, zero PnL"
          : won
            ? `bet ${pos.side} == winner ${winner}`
            : `bet ${pos.side} != winner ${winner}`,
      })}`,
    )
    logEvent(
      "trade",
      `Standing limit SETTLED ${pos.marketId}: ${pos.side} ${result} — PnL ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}, pool $${balanceAfter.toFixed(2)} [${source}]`,
    )
    insertOrderLog({
      mode: this.deps.getMode(),
      event: "SETTLED",
      marketId: pos.marketId,
      side: pos.side,
      price: pos.price,
      shares: pos.shares,
      detail: `standing-limit ${result} winner=${winner ?? "none"} src=${source} pnl=$${pnl.toFixed(4)}`,
    })
  }

  /**
   * Close every currently-open ledger row as SCRATCH (no PnL). Used when the
   * user cancels or re-arms mid-market so positions never linger as OPEN.
   */
  private scratchOpenPositions(reason: string) {
    if (this.positions.length === 0) return
    const bankroll = this.deps.getBankroll()
    for (const pos of this.positions) {
      if (pos.tradeId === null) continue
      try {
        const updated = settleTrade({
          id: pos.tradeId,
          result: "SCRATCH",
          pnl: 0,
          balanceAfter: bankroll.balance + bankroll.dustReserve,
          // SCRATCH has no PnL; when live data is unavailable fall back to the
          // entry price rather than writing a modeled value.
          markPrice: this.displayMarkForSide(pos.side) ?? (pos.shares > 0 ? pos.cost / pos.shares : 0),
          explanation: JSON.stringify({
            settlement: `SCRATCH — position closed on ${reason} before the market resolved; entry cost refunded so the slot nets zero`,
            pnlCalc: `cost $${pos.cost.toFixed(4)} refunded; realized PnL $0.0000`,
          }),
        })
        // A SCRATCH must REFUND the entry cost debited at fill time. Skipping
        // the refund (the old behavior) silently destroyed pool money on every
        // cancel/re-arm with an open position — an unexplained phantom loss.
        // Refund only if THIS call settled the row (idempotency: never
        // double-credit a row another path already settled).
        if (updated > 0) {
          bankroll.settle(pos.cost)
          try {
            this.executor?.creditSettlement?.(pos.cost)
          } catch {
            /* wallet mirror must never crash cancel/arm */
          }
          try {
            updateSettledBalance(pos.tradeId, bankroll.balance + bankroll.dustReserve)
          } catch {
            /* display-only field */
          }
        }
        logEvent(
          "info",
          `Standing limit: open position closed as SCRATCH on ${reason} (ledger #${pos.tradeId}) — cost $${pos.cost.toFixed(2)} refunded to the pool`,
        )
      } catch {
        /* never crash cancel/arm */
      }
    }
    this.positions = []
  }

  private cancelRestingOrder() {
    const order = this.restingOrder
    this.restingOrder = null
    this.restingSide = null
    if (order) this.persistState()
    if (order && this.executor) {
      // Persist the cancellation to the append-only audit trail so every order
      // action (SUBMITTED → CANCELLED) is reconcilable, not only fills. Without
      // this, a submitted order that never fills leaves no closing record.
      insertOrderLog({
        mode: this.deps.getMode(),
        event: "CANCELLED",
        marketId: order.marketId,
        tokenId: order.tokenId,
        exchangeOrderId: order.exchangeOrderId,
        side: order.side,
        price: order.price,
        shares: order.shares,
        phase: "WAITING",
        detail: "standing-limit resting order cancelled",
      })
      void this.executor.cancelOrder(order).catch(() => {})
    }
  }
}
