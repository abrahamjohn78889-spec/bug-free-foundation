/**
 * Settlement repair engine — the audited, idempotent correction path for
 * settled trades whose booked outcome disagrees with the OFFICIAL Polymarket
 * resolution.
 *
 * Design contract (Phase 4):
 *  - A repair may ONLY be driven by official-resolution evidence. Spot
 *    fallback, majority heuristics, or any other soft signal can never
 *    rewrite a booked trade.
 *  - Every repair is atomic over {trade row, bankroll, wallet mirror} and
 *    leaves a permanent evidence trail: a `settlementRepair` block merged
 *    into the trade's explanation JSON, a REPAIRED order_log row, a CRITICAL
 *    event-log entry, and a Telegram notification.
 *  - Idempotent: a kv marker per trade uid guarantees a repair can never be
 *    applied twice (no double-credit), even across restarts or concurrent
 *    sweeps.
 *  - Mode-parameterised: identical behaviour for PAPER_V1 and LIVE_V2 — the
 *    bankroll is the mode's own kv-backed pool; the wallet mirror is an
 *    optional callback because only the live process holds the executor.
 *
 * Origin: Phase 4 forensic audit — the verifier detected mismatches (e.g.
 * spot-fallback booking LOSS while the official Chainlink resolution said
 * WIN) but had no repair path, so wrong results, wrong PnL, and a wrong
 * bankroll persisted forever. SCRATCH trades from restart-orphan recovery
 * were likewise never upgraded once the official result appeared.
 */

import { getDbHandle, kvGet, kvSet, insertOrderLog, updateSettledBalance } from "./db"
import { Bankroll } from "./bankroll"
import { logEvent } from "./events"
import { notify } from "./notifier"
import type { PipelineMode, TradeSide } from "./types"

/** Booked trade fields needed to compute and apply a repair. */
export interface RepairableTrade {
  id: number
  tradeUid: string | null
  marketId: string
  slotEndMs: number
  side: TradeSide
  price: number
  shares: number
  cost: number
  result: "WIN" | "LOSS" | "SCRATCH" | "OPEN"
  pnl: number
  mode: PipelineMode
}

/** The expected (correct) settlement for a trade given the official winner. */
export interface ExpectedSettlement {
  result: "WIN" | "LOSS"
  /** What the pool should have been credited at settlement. */
  payout: number
  pnl: number
  markPrice: number
}

export interface RepairOutcome {
  applied: boolean
  reason: string
  /** USD credited (+) or debited (−) to the mode's bankroll. 0 when skipped. */
  balanceDelta: number
}

const repairKey = (uidOrId: string) => `repair:settle:${uidOrId}`

/**
 * Pure math: what SHOULD this trade have settled as, given the official
 * winner? WIN pays shares × $1.00; LOSS pays $0. (SCRATCH is only ever valid
 * when no official resolution exists, so it is never an *expected* outcome
 * here — callers only invoke this with official evidence in hand.)
 */
export function computeExpected(trade: Pick<RepairableTrade, "side" | "shares" | "cost">, officialWinner: TradeSide): ExpectedSettlement {
  const won = trade.side === officialWinner
  const payout = won ? trade.shares : 0
  const pnl = Math.round((payout - trade.cost) * 10000) / 10000
  return { result: won ? "WIN" : "LOSS", payout, pnl, markPrice: won ? 1 : 0 }
}

/**
 * The payout the pool ACTUALLY received when the trade was booked, derived
 * from the booked result (mirror of recordSettlement's payout math):
 * WIN → shares, LOSS → 0, SCRATCH → cost refund.
 */
export function bookedPayout(trade: Pick<RepairableTrade, "result" | "shares" | "cost">): number {
  if (trade.result === "WIN") return trade.shares
  if (trade.result === "SCRATCH") return trade.cost
  return 0
}

/**
 * Atomic audited repair of ONE settled trade against the official resolution.
 *
 * Applies, in order:
 *  1. idempotency check (kv marker per trade uid — refuses a second run),
 *  2. trade-row rewrite (result, pnl, mark_price, `settlementRepair`
 *     explanation block with old values + evidence),
 *  3. bankroll adjustment by exactly `expectedPayout − bookedPayout`
 *     (payout-delta accounting: the cost debit at fill time is untouched,
 *     so only the settlement credit needs correcting),
 *  4. wallet mirror via the optional callback (PAPER wallet / LIVE ledger),
 *  5. permanent REPAIRED order_log row + CRITICAL log + Telegram alert.
 *
 * Never throws — a failed repair reports `applied: false` with the reason.
 */
export function repairTrade(
  trade: RepairableTrade,
  officialWinner: TradeSide,
  opts?: {
    /** Who requested the repair (verifier sweep, audit CLI…) — audit trail. */
    requestedBy?: string
    /** Mirror the balance delta into the executor wallet (PAPER_V1). */
    creditWallet?: (usdDelta: number) => void
  },
): RepairOutcome {
  const uid = trade.tradeUid ?? `id-${trade.id}`
  const requestedBy = opts?.requestedBy ?? "unknown"

  // ---- 1. Idempotency: one repair per trade, ever. ----
  const marker = kvGet(repairKey(uid))
  if (marker) {
    return { applied: false, reason: `already repaired (${marker})`, balanceDelta: 0 }
  }

  if (trade.result === "OPEN") {
    return { applied: false, reason: "trade is still OPEN — repair only applies to settled rows", balanceDelta: 0 }
  }

  const expected = computeExpected(trade, officialWinner)
  const oldPayout = bookedPayout(trade)
  const delta = Math.round((expected.payout - oldPayout) * 10000) / 10000

  if (trade.result === expected.result && Math.abs(trade.pnl - expected.pnl) < 0.005) {
    return { applied: false, reason: "booked settlement already matches official resolution", balanceDelta: 0 }
  }

  // ---- 2. Rewrite the trade row (merge repair evidence into explanation). ----
  const db = getDbHandle()
  const won = expected.result === "WIN"
  // Overwrite the human-readable settlement fields so the ledger UI shows a
  // single coherent story after repair. Without this, `settlement`, `pnlCalc`,
  // `resolvedWinner`, and `resolutionSource` stay frozen at the original
  // (SCRATCH / spot-fallback / wrong-side) values while STATUS + PnL columns
  // reflect the corrected outcome — trades that were auto-repaired from
  // SCRATCH to WIN appear in the dashboard as "WIN +$0.10" next to a
  // "SCRATCH — cost refunded; realized PnL $0.0000" explanation, which is
  // exactly the accounting-mismatch users see on the compounding ledger.
  // NOTE: do NOT mention the prior result label (e.g. "SCRATCH") in these
  // human-readable strings — the audit trail lives in `settlementRepair.old`.
  // Bug #004b test asserts the visible settlement text no longer echoes the
  // stale label so the ledger UI can't contradict itself.
  const repairedSettlementText = won
    ? `WIN — bet ${trade.side}, official winner ${officialWinner} (source: settlement-repair); each share paid out $1.00 (auto-repaired)`
    : `LOSS — bet ${trade.side}, official winner ${officialWinner} (source: settlement-repair); shares expired worthless (auto-repaired)`
  const repairedPnlCalcText = `payout $${expected.payout.toFixed(4)} − cost $${trade.cost.toFixed(4)} = ${expected.pnl >= 0 ? "+" : ""}$${expected.pnl.toFixed(4)} (auto-repaired)`
  const repairBlock = {
    settlement: repairedSettlementText,
    pnlCalc: repairedPnlCalcText,
    resolvedWinner: officialWinner,
    resolutionSource: "settlement-repair",
    settlementRepair: {
      repairedAtMs: Date.now(),
      requestedBy,
      officialWinner,
      old: { result: trade.result, pnl: trade.pnl, payout: oldPayout },
      new: { result: expected.result, pnl: expected.pnl, payout: expected.payout },
      balanceDelta: delta,
      evidence: `official Polymarket resolution for slot ${trade.slotEndMs}: winner ${officialWinner}`,
    },
  }
  try {
    const prev =
      (db.prepare(`SELECT explanation FROM trades WHERE id = ?`).get(trade.id) as { explanation: string | null } | undefined)
        ?.explanation ?? null
    let merged: string
    try {
      // repairBlock spreads LAST so the corrected settlement/pnlCalc/winner/
      // source strings win over any stale values from the original booking.
      merged = JSON.stringify({ ...(prev ? (JSON.parse(prev) as Record<string, unknown>) : {}), ...repairBlock })
    } catch {
      merged = JSON.stringify(repairBlock)
    }
    const info = db
      .prepare(
        `UPDATE trades SET result = ?, pnl = ?, mark_price = ?, explanation = ? WHERE id = ? AND status = 'SETTLED'`,
      )
      .run(expected.result, expected.pnl, expected.markPrice, merged, trade.id)
    if (Number(info.changes ?? 0) === 0) {
      return { applied: false, reason: `trade row #${trade.id} not found or not SETTLED`, balanceDelta: 0 }
    }
  } catch (e) {
    return { applied: false, reason: `row rewrite failed: ${e instanceof Error ? e.message : String(e)}`, balanceDelta: 0 }
  }


  // Set the marker IMMEDIATELY after the row rewrite commits — the row is the
  // authority; everything after is compensation that must never repeat.
  kvSet(repairKey(uid), `${trade.result}->${expected.result}:delta$${delta.toFixed(4)}:${requestedBy}`)

  // ---- 3. Bankroll adjustment (payout-delta accounting). ----
  const bankroll = new Bankroll(trade.mode)
  if (delta !== 0) bankroll.settle(delta)
  // Stamp the corrected running balance onto the row (display-only field).
  try {
    updateSettledBalance(trade.id, bankroll.balance + bankroll.dustReserve)
  } catch {
    /* display-only */
  }

  // ---- 4. Wallet mirror (PAPER simulated wallet, or live ledger). ----
  if (delta !== 0 && opts?.creditWallet) {
    try {
      opts.creditWallet(delta)
    } catch {
      /* wallet mirror must never fail the repair */
    }
  }

  // ---- 5. Permanent audit trail. ----
  const detail =
    `SETTLEMENT_REPAIRED trade_uid=${uid} #${trade.id} ${trade.result}→${expected.result} ` +
    `pnl $${trade.pnl.toFixed(4)}→$${expected.pnl.toFixed(4)} balance_delta ${delta >= 0 ? "+" : ""}$${delta.toFixed(4)} ` +
    `official_winner=${officialWinner} bet=${trade.side} shares=${trade.shares} cost=$${trade.cost.toFixed(4)} by=${requestedBy}`
  logEvent("error", `[settlement-repair] CRITICAL: ${detail}`)
  insertOrderLog({
    mode: trade.mode,
    event: "REPAIRED",
    marketId: trade.marketId,
    side: trade.side,
    price: trade.price,
    shares: trade.shares,
    detail,
  })
  notify(
    "errors",
    "SETTLEMENT REPAIRED",
    `${trade.marketId}\n${trade.result} → ${expected.result} (official winner ${officialWinner})\n` +
      `PnL $${trade.pnl.toFixed(2)} → $${expected.pnl.toFixed(2)}\n` +
      `Pool adjusted ${delta >= 0 ? "+" : ""}$${delta.toFixed(2)}\nTrade ${uid.slice(0, 8)} | by ${requestedBy}`,
  )

  return { applied: true, reason: `repaired ${trade.result}→${expected.result}`, balanceDelta: delta }
}
