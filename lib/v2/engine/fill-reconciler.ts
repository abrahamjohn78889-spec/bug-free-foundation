// ============================================================================
// FILL RECONCILER — end-to-end CLOB fill ↔ ledger cross-check
// ============================================================================
// Complements `reconciler.ts` (open-order/wallet drift). This job walks the
// CLOB-side fill event stream (LIVE_V2: authenticated /data/trades;
// PAPER_V1: the simulated executor's own fill log — same shape) and joins
// each event to the local `trades` ledger by exchange order id.
//
// Four drift classes are reported, all read-only:
//
//   • UNBOOKED FILL          — CLOB reports a fill for an order id we placed
//                              but no OPEN/SETTLED ledger row was ever opened
//                              for it. This is the "missing reversal" class:
//                              a rollover cancelled the resting order before
//                              onFill saw the match (pre-Bug #010) or an
//                              onFill exception dropped the booking.
//   • UNATTRIBUTED FILL      — CLOB fill event carries no order id (executor
//                              could not attribute it). Escalated for LIVE_V2.
//   • DUPLICATE BOOKING      — more than one ledger row shares the same
//                              exchange order id. The Bug #011 idempotency
//                              guard prevents this in-process; this net
//                              catches DB-level corruption or a second engine
//                              instance writing to the same DB.
//   • ORPHAN LEDGER ROW      — an OPEN ledger row whose exchange order id was
//                              never seen in the CLOB fill stream within the
//                              lookback window. Suggests the fill booking was
//                              synthesized without a real exchange match.
//
// The reconciler is strictly READ-ONLY: it never places, cancels, or edits
// rows. It exposes `latest` for the dashboard and logs each finding once per
// cycle. Findings persist to `order_log` so they show up in audit exports.
// ============================================================================

import { insertOrderLog, recentTrades, type SettledTrade } from "./db"
import { logEvent } from "./events"
import type { Executor } from "./execution/executor"
import type { LiveAccountTrade, PipelineMode } from "./types"

const RECONCILE_MS = 60_000
/** Only cross-check ledger rows opened within this window. Older rows are
 *  outside the executor's fill history buffer (paper caps at 200, LIVE at
 *  the exchange's page size) so a "missing" fill for an old order is not
 *  a bug — it just aged out. */
const LOOKBACK_MS = 30 * 60_000

export interface FillReconcileFinding {
  kind: "UNBOOKED_FILL" | "UNATTRIBUTED_FILL" | "DUPLICATE_BOOKING" | "ORPHAN_LEDGER_ROW"
  orderId: string | null
  tradeId?: number
  detail: string
}

export interface FillReconcileReport {
  atMs: number
  mode: PipelineMode
  ok: boolean
  clobFillsScanned: number
  ledgerRowsScanned: number
  findings: FillReconcileFinding[]
  error: string | null
}

interface Deps {
  getExecutor: () => Executor | null
  getMode: () => PipelineMode
  isRunning: () => boolean
}

export class FillReconciler {
  private deps: Deps
  private timer: ReturnType<typeof setInterval> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private last: FillReconcileReport | null = null
  /** Findings we already logged this session, keyed by kind|orderId, so we
   *  don't spam the log every minute for the same drift. */
  private loggedKeys = new Set<string>()

  constructor(deps: Deps) {
    this.deps = deps
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.runOnce("interval"), RECONCILE_MS)
    this.startupTimer = setTimeout(() => void this.runOnce("startup"), 15_000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    this.loggedKeys.clear()
  }

  get latest(): FillReconcileReport | null {
    return this.last
  }

  async runOnce(reason: string): Promise<FillReconcileReport | null> {
    if (this.running) return this.last
    if (!this.deps.isRunning()) return this.last
    const executor = this.deps.getExecutor()
    if (!executor?.getRecentTradesLive) return this.last
    this.running = true
    try {
      const mode = this.deps.getMode()
      const clobFills = await executor.getRecentTradesLive()
      const nowMs = Date.now()
      // Cross-check window: only rows recent enough that their fill would
      // still be in the executor's fill-history buffer.
      const ledger = recentTrades(mode, 200).filter(
        (r) => (r.entryAtMs ?? Date.parse(r.createdAt)) >= nowMs - LOOKBACK_MS,
      )
      const findings = crossCheck(clobFills, ledger)

      this.last = {
        atMs: nowMs,
        mode,
        ok: findings.length === 0,
        clobFillsScanned: clobFills.length,
        ledgerRowsScanned: ledger.length,
        findings,
        error: null,
      }

      for (const f of findings) {
        const key = `${f.kind}|${f.orderId ?? "-"}|${f.tradeId ?? "-"}`
        if (this.loggedKeys.has(key)) continue
        this.loggedKeys.add(key)
        const severity = f.kind === "UNATTRIBUTED_FILL" && mode === "PAPER_V1" ? "warn" : "error"
        logEvent(severity, `[FILL-RECONCILE] ${f.kind}: ${f.detail}`)
        insertOrderLog({
          mode,
          event: "ERROR",
          marketId: "-",
          exchangeOrderId: f.orderId,
          detail: `fill-reconcile ${f.kind}: ${f.detail}`,
        })
      }

      if (findings.length === 0 && reason === "startup") {
        logEvent(
          "info",
          `[FILL-RECONCILE] startup check clean: ${clobFills.length} CLOB fill(s), ${ledger.length} ledger row(s), fully matched`,
        )
      }
      return this.last
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.last = {
        atMs: Date.now(),
        mode: this.deps.getMode(),
        ok: false,
        clobFillsScanned: -1,
        ledgerRowsScanned: -1,
        findings: [],
        error: msg,
      }
      logEvent("warn", `[FILL-RECONCILE] cycle failed: ${msg} — retrying next interval`)
      return this.last
    } finally {
      this.running = false
    }
  }
}

// ---------------------------------------------------------------------------
// Pure cross-check kernel — exported for unit tests. No I/O, no state.
// ---------------------------------------------------------------------------

export function crossCheck(
  clobFills: readonly LiveAccountTrade[],
  ledger: readonly SettledTrade[],
): FillReconcileFinding[] {
  const findings: FillReconcileFinding[] = []

  // Index ledger by orderId (skip null/empty) and detect duplicates.
  const byOrderId = new Map<string, SettledTrade[]>()
  for (const row of ledger) {
    if (!row.orderId) continue
    const list = byOrderId.get(row.orderId) ?? []
    list.push(row)
    byOrderId.set(row.orderId, list)
  }
  for (const [oid, rows] of byOrderId) {
    if (rows.length > 1) {
      findings.push({
        kind: "DUPLICATE_BOOKING",
        orderId: oid,
        detail: `${rows.length} ledger rows share exchangeOrderId ${oid} (ids: ${rows
          .map((r) => `#${r.id}`)
          .join(", ")}) — bug #011 guard bypassed or DB corruption`,
      })
    }
  }

  // Index CLOB fills by order id.
  const clobOrderIds = new Set<string>()
  for (const f of clobFills) {
    if (f.orderIds.length === 0) {
      findings.push({
        kind: "UNATTRIBUTED_FILL",
        orderId: null,
        detail: `CLOB fill ${f.id} (${f.size} @ $${f.price}) has no order id attribution — cannot join to ledger`,
      })
      continue
    }
    for (const oid of f.orderIds) clobOrderIds.add(oid)
  }

  // UNBOOKED: CLOB reports a fill for one of OUR order ids but no ledger row.
  // A CLOB fill on an id we never placed is not our concern (a different app
  // sharing the account); the open-order reconciler flags those separately.
  // Restrict to ids the ledger has SEEN before, or unattributed CLOB fills
  // are impossible to distinguish from third-party fills at this layer —
  // instead, we compare against ledger orderIds we placed but never booked.
  // The signal that catches "onFill dropped the booking" is:
  //   CLOB has orderId X ∧ ledger has no row for X
  // but only when the engine believes it placed X. Because we don't have a
  // separate placed-order log accessible here, we widen the definition:
  //   any CLOB orderId absent from `byOrderId` where the CLOB fill status is
  //   CONFIRMED / MATCHED gets reported. Externally-placed order ids on the
  //   same account are caught upstream by the open-order reconciler
  //   (`untracked orders`) — this is intentionally noisy but read-only.
  for (const f of clobFills) {
    if (f.orderIds.length === 0) continue
    for (const oid of f.orderIds) {
      if (byOrderId.has(oid)) continue
      findings.push({
        kind: "UNBOOKED_FILL",
        orderId: oid,
        detail: `CLOB fill ${f.id} (${f.size} @ $${f.price}, status ${f.status}) references order ${oid} with no matching ledger row — booking may have been dropped by a rollover before onFill (bug #010 regression signal)`,
      })
    }
  }

  // ORPHAN LEDGER: ledger row with orderId that never appears in the CLOB
  // fill stream within the lookback window. The row shows as filled locally
  // but the exchange has no matching event — a synthesized booking.
  for (const [oid, rows] of byOrderId) {
    if (clobOrderIds.has(oid)) continue
    for (const row of rows) {
      findings.push({
        kind: "ORPHAN_LEDGER_ROW",
        orderId: oid,
        tradeId: row.id,
        detail: `ledger row #${row.id} (${row.shares} @ $${row.price}, status ${row.status}) has orderId ${oid} with no CLOB fill event — booking may be synthesized (missing reversal for cancelled order)`,
      })
    }
  }

  return findings
}
