import { exportTrades, insertOrderLog, kvGet, kvSet } from "./db"
import { logEvent } from "./events"
import { notify } from "./notifier"
import { bookedPayout } from "./settlement-repair"
import type { Bankroll } from "./bankroll"
import type { PipelineMode } from "./types"

// ---------------------------------------------------------------------------
// CONTINUOUS ACCOUNTING VERIFIER (Phase 5)
//
// The settlement verifier (Phase 4) checks trades against the EXCHANGE truth
// (official resolutions). This verifier checks the ledger against ITSELF and
// against the live bankroll — the pure-math identities that must hold no
// matter what the exchange did:
//
//   Identity A — per-trade PnL:      pnl == payout(result, shares, cost) − cost
//   Identity B — balance chain:      balance_after[i] − balance_after[i−1] == pnl[i]
//   Identity C — bankroll agreement: bankroll pool == last balance_after − open costs
//   Identity D — sizing conformance: booked shares deviating from the config
//                must carry a partialFill / RISK_CLAMP audit trail
//
// Report-only for A/B/D (settled rows are historical facts; row REPAIR is the
// settlement-verifier's job because it needs exchange evidence). Identity C
// may auto-reconcile by re-stamping the bankroll from the ledger, because the
// ledger is the authority and the kv bankroll is derived state.
//
// Identical in PAPER_V1 and LIVE_V2 — it reads only the ledger + kv bankroll.
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 5 * 60_000
const TOLERANCE_USD = 0.01
/** Only alert once per (identity, trade/day) — kv-persisted across restarts. */
const alertKey = (mode: PipelineMode, kind: string, ref: string) => `acctverify:${mode}:${kind}:${ref}`

export interface AccountingAuditSummary {
  atMs: number
  mode: PipelineMode
  settledChecked: number
  pnlIdentityViolations: number
  balanceChainBreaks: number
  bankrollDriftUsd: number | null
  bankrollReconciled: boolean
  sizingDeviationsUnexplained: number
  /** Ledger-derived balance (last settled balance_after), for UI agreement. */
  ledgerBalance: number | null
  /** Live bankroll pool (balance + dust) at audit time. */
  bankrollPool: number
}

export interface AccountingVerifierDeps {
  getBankroll: () => Bankroll
  /** Open-trade cost total (fills debited but not yet settled) for Identity C. */
  getOpenCostUsd?: () => number
  /** Configured FIXED_SHARES count for Identity D, or null when not applicable. */
  getConfiguredShares?: () => { sizingMode: string; shares: number } | null
}

let timer: ReturnType<typeof setInterval> | null = null
let running = false
let lastSummary: AccountingAuditSummary | null = null

export function getLastAccountingAudit(): AccountingAuditSummary | null {
  return lastSummary
}

/** Permanent CRITICAL audit row + throttled Telegram for a violated identity. */
function reportViolation(mode: PipelineMode, kind: string, ref: string, detail: string) {
  const key = alertKey(mode, kind, ref)
  if (kvGet(key)) return // already reported this exact violation
  kvSet(key, new Date().toISOString())
  logEvent("error", `[accounting] CRITICAL ${kind}: ${detail}`)
  insertOrderLog({ mode, event: "ERROR", marketId: ref, detail: `ACCOUNTING_VERIFIER ${kind}: ${detail.slice(0, 400)}` })
  notify("orders", `ACCOUNTING ${kind}`, detail.slice(0, 300))
}

/**
 * Run one full accounting sweep. Pure math over the ledger — no network.
 * Never throws; failures degrade to a logged warning.
 */
export function verifyAccounting(mode: PipelineMode, deps: AccountingVerifierDeps): AccountingAuditSummary {
  const bankroll = deps.getBankroll()
  const summary: AccountingAuditSummary = {
    atMs: Date.now(),
    mode,
    settledChecked: 0,
    pnlIdentityViolations: 0,
    balanceChainBreaks: 0,
    bankrollDriftUsd: null,
    bankrollReconciled: false,
    sizingDeviationsUnexplained: 0,
    ledgerBalance: null,
    bankrollPool: Math.round((bankroll.balance + bankroll.dustReserve) * 10000) / 10000,
  }
  try {
    const rows = exportTrades(mode).filter((r) => r.status === "SETTLED")
    summary.settledChecked = rows.length

    let prevBalance: number | null = null
    for (const r of rows) {
      const uid = String(r.trade_uid ?? r.id)
      const result = String(r.result) as "WIN" | "LOSS" | "SCRATCH"
      const shares = Number(r.shares ?? 0)
      const cost = Number(r.cost ?? 0)
      const pnl = Number(r.pnl ?? 0)
      const balanceAfter = Number(r.balance_after ?? 0)

      // Identity A: pnl == bookedPayout − cost.
      const expectedPnl = Math.round((bookedPayout({ result, shares, cost }) - cost) * 10000) / 10000
      if (Math.abs(pnl - expectedPnl) > TOLERANCE_USD) {
        summary.pnlIdentityViolations++
        reportViolation(
          mode,
          "PNL_IDENTITY",
          uid,
          `trade ${uid}: booked pnl $${pnl.toFixed(4)} but ${result} with ${shares} shares @ cost $${cost.toFixed(4)} implies $${expectedPnl.toFixed(4)}`,
        )
      }

      // Identity B: consecutive balance chain moves by exactly the pnl.
      if (prevBalance !== null) {
        const delta = Math.round((balanceAfter - prevBalance) * 10000) / 10000
        if (Math.abs(delta - pnl) > TOLERANCE_USD) {
          summary.balanceChainBreaks++
          reportViolation(
            mode,
            "BALANCE_CHAIN",
            uid,
            `trade ${uid}: balance moved $${delta.toFixed(4)} (from $${prevBalance.toFixed(4)} to $${balanceAfter.toFixed(4)}) but booked pnl is $${pnl.toFixed(4)}`,
          )
        }
      }
      prevBalance = balanceAfter

      // Identity D: FIXED_SHARES conformance — deviations must be explained.
      const configured = deps.getConfiguredShares?.()
      if (configured && configured.sizingMode === "FIXED_SHARES" && shares !== configured.shares) {
        const explanation = String(r.explanation ?? "")
        const explained = explanation.includes("partialFill") || explanation.includes("RISK_CLAMP") || explanation.includes("riskClamp")
        if (!explained) {
          summary.sizingDeviationsUnexplained++
          reportViolation(
            mode,
            "SIZING_DEVIATION",
            uid,
            `trade ${uid}: booked ${shares} shares but FIXED_SHARES config is ${configured.shares} with NO partialFill/riskClamp audit trail`,
          )
        }
      }
    }

    // Identity C: bankroll pool == last settled balance − open (unsettled) costs.
    if (prevBalance !== null) {
      summary.ledgerBalance = prevBalance
      const openCost = deps.getOpenCostUsd?.() ?? 0
      const expectedPool = Math.round((prevBalance - openCost) * 10000) / 10000
      const drift = Math.round((summary.bankrollPool - expectedPool) * 10000) / 10000
      summary.bankrollDriftUsd = drift
      if (Math.abs(drift) > TOLERANCE_USD) {
        reportViolation(
          mode,
          "BANKROLL_DRIFT",
          `day-${new Date().toISOString().slice(0, 10)}`,
          `bankroll pool $${summary.bankrollPool.toFixed(4)} diverges from ledger-derived $${expectedPool.toFixed(4)} (last balance $${prevBalance.toFixed(4)} − open costs $${openCost.toFixed(4)}); drift $${drift.toFixed(4)} — auto-reconciling bankroll to the ledger`,
        )
        // Identity C auto-reconcile: the ledger is the authority; the kv
        // bankroll is derived state, so re-stamp it (dust preserved).
        bankroll.balance = Math.max(0, Math.round((expectedPool - bankroll.dustReserve) * 10000) / 10000)
        summary.bankrollReconciled = true
      }
    }
  } catch (e) {
    logEvent("warn", `[accounting] sweep failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  lastSummary = summary
  return summary
}

/** Start the periodic sweep (idempotent). Runs immediately, then every 5 min. */
export function startAccountingVerifier(getMode: () => PipelineMode, deps: AccountingVerifierDeps): void {
  if (timer) return
  const run = () => {
    if (running) return
    running = true
    try {
      verifyAccounting(getMode(), deps)
    } finally {
      running = false
    }
  }
  run()
  timer = setInterval(run, SWEEP_INTERVAL_MS)
  if (typeof timer === "object" && "unref" in timer) timer.unref()
  logEvent("info", "[accounting] continuous accounting verifier started (identities A–D every 5 min)")
}

export function stopAccountingVerifier(): void {
  if (timer) clearInterval(timer)
  timer = null
}
