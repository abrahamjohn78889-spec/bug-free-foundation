// ============================================================================
// EXCHANGE RECONCILER — periodic exchange-truth vs local-state comparison
// ============================================================================
// Every RECONCILE_MS while the engine runs in LIVE_V2, this module pulls the
// account's ACTUAL open orders and wallet balance from the exchange and
// compares them against what the engine believes:
//
//   • UNTRACKED ORDER  — a live order on the account that neither the strategy
//     engine nor the Standing Limit Order is tracking. This is the single most
//     dangerous drift state (it can fill with real money, unobserved), so it
//     is logged as an ERROR every cycle until it disappears or is cancelled.
//   • MISSING ORDER    — an order the engine believes is resting that the
//     exchange no longer lists (externally cancelled/filled unseen). Handled
//     live by the SLO stuck-RESTING guard; reported here as a cross-check.
//   • WALLET DRIFT     — bankroll balance vs on-chain collateral differing by
//     more than DRIFT_TOLERANCE_USD (informational; the engine re-syncs the
//     wallet at every rollover).
//
// The reconciler is strictly READ-ONLY: it never cancels or places orders.
// It observes, logs, and exposes its latest report for the dashboard.
// ============================================================================

import { logEvent } from "./events"
import type { Executor } from "./execution/executor"
import type { OpenOrder } from "./types"

const RECONCILE_MS = 60_000
const DRIFT_TOLERANCE_USD = 1

export interface ReconcileReport {
  atMs: number
  ok: boolean
  exchangeOpenOrders: number
  trackedOrders: number
  untrackedOrderIds: string[]
  missingOrderIds: string[]
  walletUsd: number | null
  localBalanceUsd: number
  walletDriftUsd: number | null
  error: string | null
}

interface Deps {
  getExecutor: () => Executor | null
  /** Every order id the engine currently believes is resting on the book. */
  getTrackedOrders: () => OpenOrder[]
  getLocalBalanceUsd: () => number
  isLive: () => boolean
  isRunning: () => boolean
}

export class Reconciler {
  private deps: Deps
  private timer: ReturnType<typeof setInterval> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private last: ReconcileReport | null = null

  constructor(deps: Deps) {
    this.deps = deps
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.runOnce("interval"), RECONCILE_MS)
    // First pass shortly after ignition, once feeds settle. Tracked so a
    // stop()/dispose() before the 10s mark can't fire an orphaned late pass.
    this.startupTimer = setTimeout(() => void this.runOnce("startup"), 10_000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
  }

  get latest(): ReconcileReport | null {
    return this.last
  }

  async runOnce(reason: string): Promise<ReconcileReport | null> {
    if (this.running) return this.last
    if (!this.deps.isLive() || !this.deps.isRunning()) return this.last
    const executor = this.deps.getExecutor()
    if (!executor?.getOpenOrdersLive) return this.last
    this.running = true
    try {
      const exchangeOrders = await executor.getOpenOrdersLive()
      const exchangeIds = new Set(exchangeOrders.map((o) => o.id))
      const tracked = this.deps.getTrackedOrders()
      const trackedIds = new Set(
        tracked.map((o) => o.exchangeOrderId).filter((id): id is string => typeof id === "string" && id.length > 0),
      )

      const untracked = [...exchangeIds].filter((id) => !trackedIds.has(id))
      const missing = [...trackedIds].filter((id) => !exchangeIds.has(id))

      let walletUsd: number | null = null
      if (executor.getAvailableBalanceUsd) {
        walletUsd = await executor.getAvailableBalanceUsd()
      }
      const localBalance = this.deps.getLocalBalanceUsd()
      const drift = walletUsd === null ? null : Math.round((walletUsd - localBalance) * 100) / 100

      const ok = untracked.length === 0 && missing.length === 0
      this.last = {
        atMs: Date.now(),
        ok,
        exchangeOpenOrders: exchangeOrders.length,
        trackedOrders: trackedIds.size,
        untrackedOrderIds: untracked,
        missingOrderIds: missing,
        walletUsd,
        localBalanceUsd: Math.round(localBalance * 100) / 100,
        walletDriftUsd: drift,
        error: null,
      }

      if (untracked.length > 0) {
        logEvent(
          "error",
          `[RECONCILE] ${untracked.length} UNTRACKED live order(s) on the account: ${untracked.slice(0, 3).join(", ")}${untracked.length > 3 ? "…" : ""} — these can fill unobserved; cancel manually or via kill switch`,
        )
      }
      if (missing.length > 0) {
        logEvent(
          "warn",
          `[RECONCILE] ${missing.length} tracked order(s) NOT on the exchange: ${missing.slice(0, 3).join(", ")} — externally cancelled or filled unseen (stuck-RESTING guard will clear)`,
        )
      }
      if (drift !== null && Math.abs(drift) > DRIFT_TOLERANCE_USD) {
        const isPaper = !this.deps.isLive()
        const pipelineLabel = isPaper ? "PAPER_V1" : "LIVE_V2"
        const reason_text = isPaper
          ? "Paper trading profits/losses not reflected in the fixed exchange wallet reference"
          : "Possible untracked fills or external transfers"
        logEvent(
          "info",
          `[RECONCILE] wallet divergence $${drift.toFixed(2)}: exchange $${walletUsd!.toFixed(2)} vs ${pipelineLabel} $${localBalance.toFixed(2)}\nReason: ${reason_text}\nReconciliation: ${isPaper ? "Expected for paper trading — no action required" : "Re-syncs at next rollover"}`,
        )
      }
      if (ok && reason === "startup") {
        logEvent("info", `[RECONCILE] startup check clean: ${exchangeOrders.length} exchange order(s), all tracked`)
      }
      return this.last
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.last = {
        atMs: Date.now(),
        ok: false,
        exchangeOpenOrders: -1,
        trackedOrders: this.deps.getTrackedOrders().length,
        untrackedOrderIds: [],
        missingOrderIds: [],
        walletUsd: null,
        localBalanceUsd: Math.round(this.deps.getLocalBalanceUsd() * 100) / 100,
        walletDriftUsd: null,
        error: msg,
      }
      logEvent("warn", `[RECONCILE] cycle failed: ${msg} — retrying next interval`)
      return this.last
    } finally {
      this.running = false
    }
  }
}

// ============================================================================
// INC-004 Stage 5 — AMBIGUOUS intent recovery + orphan / duplicate quarantine.
//
// Recovery pass, invoked out-of-band from the periodic reconciler loop:
//   • Enumerates every AMBIGUOUS intent (oldest first).
//   • Looks up live exchange orders sharing that intent's client_order_id.
//   • 0 matches  → intent transitions AMBIGUOUS → FAILED
//                  reason "reconciled_absent".
//   • 1 match    → intent transitions AMBIGUOUS → RESTING with that
//                  exchange_order_id.
//   • >1 matches → deterministic promotion (lowest exchange id) becomes
//                  the canonical order; every other exchange id is written
//                  to quarantined_exchange_orders with reason
//                  "duplicate_for_intent" and the intent moves to RESTING.
//
// The pass is read-mostly against the exchange (one lookup call per
// ambiguous intent). It does NOT cancel, replace, or place orders — that
// stays out-of-scope until an operator or Stage 6+ policy decides.
//
// Design constraints:
//   • Never mutates strategy, settlement, or Stage 4 execution flow.
//   • Never creates new intents.
//   • Never introduces UNIQUE constraints (Stage 6).
//   • Every state change goes through the rowcount-gated Stage 2 helpers so
//     concurrent recovery attempts cannot double-transition an intent.
// ============================================================================

import {
  IntentStatus,
  listAmbiguousIntents,
  markIntentFailed,
  markIntentResting,
  quarantineExchangeOrder,
} from "./db"

export interface ExchangeOrderMatch {
  exchangeOrderId: string
  raw?: unknown
}

export interface ExchangeIntentLookup {
  /**
   * Return every live exchange order that carries the given
   * client_order_id. Must return [] (never throw) when the exchange
   * confirms the order is not present.
   */
  findOrdersByClientOrderId(coid: string): Promise<ExchangeOrderMatch[]>
}

export interface AmbiguousRecoveryResult {
  scanned: number
  resting: number
  failed: number
  quarantined: number
  errors: number
  details: Array<{
    intentId: number
    clientOrderId: string
    outcome: "resting" | "failed" | "error"
    exchangeOrderId?: string
    quarantinedExchangeOrderIds?: string[]
    error?: string
  }>
}

/**
 * Recover every AMBIGUOUS intent by asking the exchange whether the
 * order landed. See file-level block comment for the full contract.
 */
export async function recoverAmbiguousIntents(
  lookup: ExchangeIntentLookup,
  nowMs: number = Date.now(),
): Promise<AmbiguousRecoveryResult> {
  const rows = listAmbiguousIntents()
  const result: AmbiguousRecoveryResult = {
    scanned: rows.length,
    resting: 0,
    failed: 0,
    quarantined: 0,
    errors: 0,
    details: [],
  }

  for (const intent of rows) {
    // Defensive: status may have changed between listing and processing.
    if (intent.status !== IntentStatus.AMBIGUOUS) continue

    try {
      const matches = await lookup.findOrdersByClientOrderId(intent.client_order_id)

      if (matches.length === 0) {
        markIntentFailed(intent.id, "reconciled_absent", nowMs)
        result.failed += 1
        result.details.push({
          intentId: intent.id,
          clientOrderId: intent.client_order_id,
          outcome: "failed",
        })
        logEvent(
          "warn",
          `[INC-004][RECOVER] intent ${intent.id} coid=${intent.client_order_id} — exchange reports no matching order; marking FAILED`,
        )
        continue
      }

      // Deterministic canonical pick — lowest exchange id lexicographically.
      const sorted = [...matches].sort((a, b) =>
        a.exchangeOrderId < b.exchangeOrderId ? -1 : a.exchangeOrderId > b.exchangeOrderId ? 1 : 0,
      )
      const [canonical, ...duplicates] = sorted

      const quarantinedIds: string[] = []
      for (const dup of duplicates) {
        quarantineExchangeOrder({
          exchangeOrderId: dup.exchangeOrderId,
          clientOrderId: intent.client_order_id,
          intentId: intent.id,
          reason: "duplicate_for_intent",
          payload: dup.raw,
          nowMs,
        })
        quarantinedIds.push(dup.exchangeOrderId)
        result.quarantined += 1
      }

      markIntentResting(intent.id, canonical.exchangeOrderId, nowMs)
      result.resting += 1
      result.details.push({
        intentId: intent.id,
        clientOrderId: intent.client_order_id,
        outcome: "resting",
        exchangeOrderId: canonical.exchangeOrderId,
        quarantinedExchangeOrderIds: quarantinedIds.length > 0 ? quarantinedIds : undefined,
      })

      if (quarantinedIds.length > 0) {
        logEvent(
          "error",
          `[INC-004][RECOVER] intent ${intent.id} coid=${intent.client_order_id} — ${matches.length} exchange orders; promoted ${canonical.exchangeOrderId}, quarantined ${quarantinedIds.length} duplicate(s): ${quarantinedIds.join(", ")}`,
        )
      } else {
        logEvent(
          "info",
          `[INC-004][RECOVER] intent ${intent.id} coid=${intent.client_order_id} — exchange confirms ${canonical.exchangeOrderId}; promoted to RESTING`,
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      result.errors += 1
      result.details.push({
        intentId: intent.id,
        clientOrderId: intent.client_order_id,
        outcome: "error",
        error: msg,
      })
      logEvent(
        "warn",
        `[INC-004][RECOVER] intent ${intent.id} coid=${intent.client_order_id} — recovery failed: ${msg}`,
      )
    }
  }

  return result
}
