import type DatabaseType from "better-sqlite3"

// ------------------------------------------------------------------
// TRADE FORENSIC REPLAY — shared evidence-bundle + verdict builder.
//
// Reconstructs everything the system permanently stored about ONE
// trade: the trade row, its explanation JSON (incl. the Phase 1
// feedAudit when present), the full order-log chain for its market,
// relevant audit-log lines, sibling trades in the same slot, and a
// direction VERDICT derived strictly from that stored evidence.
//
// READ-ONLY: this module never writes. It accepts an injected DB
// handle so the CLI can point it at ANY database file (e.g. a copy
// of the production ledger) and the API can use the live handle.
// ------------------------------------------------------------------

export interface TradeRow {
  id: number
  market_id: string
  slot_end_ms: number
  side: string
  price: number
  shares: number
  cost: number
  result: string
  pnl: number
  balance_after: number
  mode: string
  created_at: string
  settled_at: string
  status: string | null
  order_id: string | null
  trade_uid: string | null
  entry_at_ms: number | null
  mark_price: number | null
  explanation: string | null
}

export interface OrderLogRow {
  id: number
  ts_ms: number
  mode: string
  event: string
  market_id: string
  token_id: string | null
  exchange_order_id: string | null
  side: string | null
  price: number | null
  shares: number | null
  phase: string | null
  detail: string | null
}

export interface AuditLogRow {
  id: number
  ts_ms: number
  level: string
  category: string
  message: string
}

/** Structured feedAudit written by Phase 1 (lib/v2/engine/standing-order.ts). */
export interface FeedAuditRecord {
  sideSelectionBasis?: string
  generation: number | null
  sequence: number | null
  snapshotAtMs: number | null
  triggerPrice: number | null
  triggerMode: string | null
  limitPrice: number | null
  winningSide: string
  btcReference?: {
    strike: number | null
    spot: number | null
    direction: string | null
    spotAgeMs: number | null
  }
  majority: { side: string | null; upPct: number | null; downPct: number | null } | null
  quotes: {
    up: { price: number; source: string; ageMs: number; latencyMs: number | null }
    down: { price: number; source: string; ageMs: number; latencyMs: number | null }
  } | null
  wsFreshMs: number | null
  restFreshMs: number | null
  confidence: string | null
  marketId: string
  slotEndMs: number
  lock: {
    generation: number
    marketId: string
    upTokenId: string
    downTokenId: string
    lockedAtMs: number
  } | null
}

export interface DirectionVerdict {
  /** CORRECT / WRONG_SIDE / UNPROVABLE */
  conclusion: "CORRECT" | "WRONG_SIDE" | "UNPROVABLE"
  /** Human-readable reasoning chain, one finding per line. */
  findings: string[]
  /** Evidence that would be needed but is missing (pre-Phase-1 trades). */
  missingEvidence: string[]
}

export interface TradeReplayBundle {
  trade: TradeRow
  /** Parsed explanation JSON (null if absent or unparseable). */
  explanation: Record<string, unknown> | null
  /** Structured Phase 1 feed audit (null for pre-Phase-1 trades). */
  feedAudit: FeedAuditRecord | null
  /** Full order-log chain for this trade's market (chronological). */
  orderLog: OrderLogRow[]
  /** Audit-log lines overlapping the trade's slot window (chronological). */
  auditLog: AuditLogRow[]
  /** Other trades in the same slot + mode (e.g. #202 vs #205). */
  siblingTrades: TradeRow[]
  verdict: DirectionVerdict
  /** ISO strings for the slot window, for human readability. */
  slotWindow: { startIso: string; endIso: string }
}

const TRADE_COLS = `id, market_id, slot_end_ms, side, price, shares, cost, result, pnl, balance_after,
  mode, created_at, settled_at, status, order_id, trade_uid, entry_at_ms, mark_price, explanation`

/** Safe JSON parse returning null instead of throwing. */
function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Build the complete forensic evidence bundle for one trade id.
 * Throws with a clear message when the trade does not exist.
 */
export function buildTradeReplay(db: DatabaseType.Database, tradeId: number): TradeReplayBundle {
  const trade = db.prepare(`SELECT ${TRADE_COLS} FROM trades WHERE id = ?`).get(tradeId) as TradeRow | undefined
  if (!trade) {
    const range = db.prepare(`SELECT MIN(id) lo, MAX(id) hi, COUNT(*) n FROM trades`).get() as {
      lo: number | null
      hi: number | null
      n: number
    }
    throw new Error(
      `Trade #${tradeId} not found in this database (${range.n} trades, ids ${range.lo ?? "-"}..${range.hi ?? "-"}). ` +
        `If this is the wrong ledger file, pass --db <path/to/edge5.db>.`,
    )
  }

  const explanation = parseJson(trade.explanation)
  const feedAudit = (explanation?.feedAudit as FeedAuditRecord | undefined) ?? null

  // Slot window: 5-minute candle ending at slot_end_ms.
  const slotStartMs = trade.slot_end_ms - 5 * 60_000
  // Evidence margin: capture pre-arm and post-settlement context.
  const windowLoMs = slotStartMs - 2 * 60_000
  const windowHiMs = trade.slot_end_ms + 3 * 60_000

  const orderLog = db
    .prepare(
      `SELECT id, ts_ms, mode, event, market_id, token_id, exchange_order_id, side, price, shares, phase, detail
       FROM order_log
       WHERE (market_id = ? OR (ts_ms BETWEEN ? AND ? AND mode = ?))
       ORDER BY ts_ms ASC, id ASC`,
    )
    .all(trade.market_id, windowLoMs, windowHiMs, trade.mode) as OrderLogRow[]

  // audit_log may be pruned (30d retention) — best-effort evidence.
  let auditLog: AuditLogRow[] = []
  try {
    auditLog = db
      .prepare(
        `SELECT id, ts_ms, level, category, message FROM audit_log
         WHERE ts_ms BETWEEN ? AND ? ORDER BY ts_ms ASC, id ASC`,
      )
      .all(windowLoMs, windowHiMs) as AuditLogRow[]
  } catch {
    auditLog = []
  }

  const siblingTrades = db
    .prepare(
      `SELECT ${TRADE_COLS} FROM trades
       WHERE slot_end_ms = ? AND mode = ? AND id != ? ORDER BY id ASC`,
    )
    .all(trade.slot_end_ms, trade.mode, trade.id) as TradeRow[]

  const verdict = deriveVerdict(trade, explanation, feedAudit, orderLog)

  return {
    trade,
    explanation,
    feedAudit,
    orderLog,
    auditLog,
    siblingTrades,
    verdict,
    slotWindow: {
      startIso: new Date(slotStartMs).toISOString(),
      endIso: new Date(trade.slot_end_ms).toISOString(),
    },
  }
}

/**
 * Derive the direction verdict STRICTLY from stored evidence. Never guesses:
 * when the evidence needed for a conclusion is missing (pre-Phase-1 trades),
 * the conclusion is UNPROVABLE with an explicit list of what is missing.
 *
 * Definition of CORRECT for the Standing Limit Order strategy:
 * the entered side must match the BTC-reference majority direction, and that
 * same side's best-ask must have reached the trigger price in the validated
 * snapshot that fired. Old race-policy audits (before sideSelectionBasis was
 * persisted) are still evaluated against their stored race evidence, but the
 * findings explicitly call out that they predate the majority-only fix.
 */
export function deriveVerdict(
  trade: TradeRow,
  explanation: Record<string, unknown> | null,
  feedAudit: FeedAuditRecord | null,
  orderLog: OrderLogRow[],
): DirectionVerdict {
  const findings: string[] = []
  const missingEvidence: string[] = []

  findings.push(
    `Trade #${trade.id}: ${trade.side} @ $${trade.price.toFixed(4)} × ${trade.shares} shares ($${trade.cost.toFixed(2)}) — ${trade.result}, PnL $${trade.pnl.toFixed(2)} [${trade.mode}]`,
  )

  // Order-log chain facts (available for all eras).
  const placed = orderLog.filter((r) => r.event === "SUBMITTED" && r.side === trade.side)
  const filled = orderLog.filter((r) => r.event === "FILLED" && r.side === trade.side)
  if (placed.length > 0) {
    const p = placed[0]
    findings.push(
      `Order log: ${trade.side} order SUBMITTED at ${new Date(p.ts_ms).toISOString()}${p.detail ? ` — ${p.detail}` : ""}`,
    )
  }
  if (filled.length > 0) {
    const f = filled[0]
    findings.push(`Order log: FILLED at ${new Date(f.ts_ms).toISOString()}${f.detail ? ` — ${f.detail}` : ""}`)
  }

  if (feedAudit) {
    // ---- Post-Phase-1: fully decidable from the stored snapshot ----
    const q = feedAudit.quotes
    const maj = feedAudit.majority
    if (q) {
      findings.push(
        `Trigger snapshot (gen ${feedAudit.generation}, seq ${feedAudit.sequence}, confidence ${feedAudit.confidence}): UP ask $${q.up.price.toFixed(4)} [${q.up.source}, age ${q.up.ageMs}ms] | DOWN ask $${q.down.price.toFixed(4)} [${q.down.source}, age ${q.down.ageMs}ms]`,
      )
    }
    if (maj) findings.push(`Majority side in that snapshot: ${maj.side} (UP ${maj.upPct ?? "?"}% / DOWN ${maj.downPct ?? "?"}%)`)
    if (feedAudit.btcReference) {
      const ref = feedAudit.btcReference
      findings.push(
        `BTC reference: strike ${ref.strike ?? "?"}, spot ${ref.spot ?? "?"}, direction ${ref.direction ?? "none"}, spot age ${ref.spotAgeMs ?? "?"}ms`,
      )
    }
    if (feedAudit.triggerPrice !== null) {
      findings.push(`Trigger: $${feedAudit.triggerPrice.toFixed(2)} [${feedAudit.triggerMode}] → limit $${feedAudit.limitPrice?.toFixed(2) ?? "?"}`)
    }

    if (q && feedAudit.triggerPrice !== null) {
      if (feedAudit.sideSelectionBasis === "BTC_REFERENCE_MAJORITY") {
        const refSide = feedAudit.btcReference?.direction
        const entered = trade.side === "UP" ? q.up.price : q.down.price
        const enteredAtTrigger = entered >= feedAudit.triggerPrice
        if (refSide !== "UP" && refSide !== "DOWN") {
          missingEvidence.push("BTC reference direction at trigger time")
          findings.push("VERDICT BASIS: feedAudit has no decisive BTC-reference direction, so the strategy-compliant side cannot be proven.")
          return { conclusion: "UNPROVABLE", findings, missingEvidence }
        }
        if (trade.side !== refSide) {
          findings.push(
            `VERDICT BASIS: BTC-reference majority was ${refSide}, but the trade entered ${trade.side}. That contradicts the majority-only strategy — WRONG SIDE.`,
          )
          return { conclusion: "WRONG_SIDE", findings, missingEvidence }
        }
        if (!enteredAtTrigger) {
          findings.push(
            `VERDICT BASIS: entered side ${trade.side} matched BTC-reference majority, but its ask $${entered.toFixed(4)} had NOT reached trigger $${feedAudit.triggerPrice.toFixed(2)} — WRONG SIDE/TRIGGER.`,
          )
          return { conclusion: "WRONG_SIDE", findings, missingEvidence }
        }
        findings.push(
          `VERDICT BASIS: entered side ${trade.side} matched BTC-reference majority and its ask $${entered.toFixed(4)} reached trigger $${feedAudit.triggerPrice.toFixed(2)} — CORRECT.`,
        )
        return { conclusion: "CORRECT", findings, missingEvidence }
      }

      findings.push(
        "Legacy race-policy audit: this trade predates the BTC-reference majority-only fix. CORRECT here only means it matched the old race-to-trigger rule, not the user's majority-side strategy.",
      )
      const entered = trade.side === "UP" ? q.up.price : q.down.price
      const opposite = trade.side === "UP" ? q.down.price : q.up.price
      const enteredAtTrigger = entered >= feedAudit.triggerPrice
      const oppositeAtTrigger = opposite >= feedAudit.triggerPrice
      if (enteredAtTrigger && !oppositeAtTrigger) {
        findings.push(
          `VERDICT BASIS: in the exact snapshot that fired, ONLY the entered side (${trade.side}, $${entered.toFixed(4)}) had reached the trigger — the opposite side ($${opposite.toFixed(4)}) had not. Direction decision was CORRECT.`,
        )
        return { conclusion: "CORRECT", findings, missingEvidence }
      }
      if (enteredAtTrigger && oppositeAtTrigger) {
        findings.push(
          `VERDICT BASIS: BOTH sides were at/above the trigger in the firing snapshot (${trade.side} $${entered.toFixed(4)} vs opposite $${opposite.toFixed(4)}). The engine locks the FIRST side seen at trigger; both-at-trigger in one snapshot resolves to the higher ask. ${
            entered >= opposite ? "The entered side was the higher ask — CORRECT." : "The OPPOSITE side was higher — entered side was NOT the race winner."
          }`,
        )
        return { conclusion: entered >= opposite ? "CORRECT" : "WRONG_SIDE", findings, missingEvidence }
      }
      // entered side had NOT reached the trigger in the firing snapshot.
      findings.push(
        `VERDICT BASIS: the entered side (${trade.side}, $${entered.toFixed(4)}) had NOT reached the trigger $${feedAudit.triggerPrice.toFixed(2)} in the snapshot that fired${oppositeAtTrigger ? `, while the opposite side ($${opposite.toFixed(4)}) HAD` : ""}. The entry contradicts the stored snapshot — WRONG SIDE.`,
      )
      return { conclusion: "WRONG_SIDE", findings, missingEvidence }
    }
    missingEvidence.push("feedAudit present but missing quotes/trigger fields")
    return { conclusion: "UNPROVABLE", findings, missingEvidence }
  }

  // ---- Pre-Phase-1 trade: structured snapshot evidence does not exist ----
  missingEvidence.push(
    "feedAudit (exact validated snapshot at trigger time) — this trade predates the Phase 1 audit record",
  )
  const sideSel = explanation?.sideSelection
  if (typeof sideSel === "string") {
    findings.push(`Stored side-selection note: "${sideSel}"`)
  } else {
    missingEvidence.push("explanation.sideSelection narrative")
  }
  const entry = explanation?.entry
  if (typeof entry === "string") findings.push(`Stored entry note: "${entry}"`)
  if (placed.length === 0 && filled.length === 0) {
    missingEvidence.push("order_log rows for this market (possibly pruned by 30-day retention)")
  }
  findings.push(
    "VERDICT BASIS: without the trigger-time snapshot, the stored evidence cannot prove which side reached the trigger first. What CAN be said: the narrative notes above record what the engine believed at the time; the Phase 1 feed-integrity fixes (generation guards, atomic snapshot, trigger lock, rollover barrier) close every identified mechanism by which a wrong-side entry could have occurred.",
  )
  return { conclusion: "UNPROVABLE", findings, missingEvidence }
}
