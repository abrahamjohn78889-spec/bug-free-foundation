#!/usr/bin/env npx tsx
// ------------------------------------------------------------------
// HISTORICAL LEDGER AUDIT CLI (Phase 4)
//
//   pnpm audit-ledger [--db path/to/edge5.db] [--mode PAPER_V1|LIVE_V2]
//                     [--repair] [--limit N] [--json]
//
// For every settled trade:
//   1. fetches the OFFICIAL Polymarket resolution (rate-limited),
//   2. recomputes the expected result + PnL,
//   3. prints PASS / FAIL <exact reason> per trade,
//   4. verifies the running balance chain,
//   5. prints a summary (counts by failure class, total PnL error,
//      SCRATCH-with-official count).
//
// Default is READ-ONLY. With --repair, each FAIL backed by official
// evidence is fixed via the audited settlement-repair engine (atomic,
// idempotent, permanent evidence trail + REPAIRED order_log rows).
//
// Run on the production machine:  pnpm audit-ledger
// Then, if failures are reported: pnpm audit-ledger --repair
//
// Phase 5: --accounting runs the OFFLINE pure-math reconciliation instead
// (no network, whole history): per-trade PnL identity, balance-chain walk,
// FIXED-shares conformance, and the bankroll progression summary.
//   pnpm audit-ledger --accounting [--db path] [--mode MODE] [--json]
// ------------------------------------------------------------------
import path from "node:path"
import fs from "node:fs"

const args = process.argv.slice(2)
const dbFlagIdx = args.indexOf("--db")
const dbPath = dbFlagIdx >= 0 ? args[dbFlagIdx + 1] : (process.env.DB_PATH ?? "data/edge5.db")
const modeFlagIdx = args.indexOf("--mode")
const modeArg = modeFlagIdx >= 0 ? args[modeFlagIdx + 1] : "PAPER_V1"
const limitFlagIdx = args.indexOf("--limit")
const limit = limitFlagIdx >= 0 ? Number(args[limitFlagIdx + 1]) : 500
const doRepair = args.includes("--repair")
const asJson = args.includes("--json")
const doAccounting = args.includes("--accounting")

const fullPath = path.resolve(process.cwd(), dbPath)
if (!fs.existsSync(fullPath)) {
  console.error(`Database not found: ${fullPath}\nPass --db <path> to point at the ledger file.`)
  process.exit(1)
}
if (modeArg !== "PAPER_V1" && modeArg !== "LIVE_V2") {
  console.error(`Invalid --mode ${modeArg} (expected PAPER_V1 or LIVE_V2)`)
  process.exit(1)
}

// The engine modules resolve the DB from env.DB_PATH at first import —
// point them at the requested file BEFORE any dynamic import below.
process.env.DB_PATH = fullPath

interface AuditRowResult {
  id: number
  marketId: string
  side: string
  booked: string
  bookedPnl: number
  official: string | null
  expected: string | null
  expectedPnl: number | null
  status: "PASS" | "FAIL" | "UNRESOLVED"
  reason: string
  repaired?: boolean
  repairReason?: string
}

/**
 * OFFLINE ACCOUNTING RECONCILIATION (Phase 5) — pure math over the ENTIRE
 * ledger history, no network. Verifies the identities the accounting
 * verifier checks continuously in production, plus a full bankroll
 * progression summary (start → end with every chain break listed).
 */
async function accountingMain() {
  const { exportTrades } = await import("../lib/v2/engine/db")
  const { bookedPayout } = await import("../lib/v2/engine/settlement-repair")
  const { Bankroll } = await import("../lib/v2/engine/bankroll")
  const mode = modeArg as import("../lib/v2/engine/types").PipelineMode

  const rows = exportTrades(mode).filter((r) => r.status === "SETTLED")
  const pnlViolations: string[] = []
  const chainBreaks: string[] = []
  const sizingDeviations: string[] = []
  let prevBalance: number | null = null
  let firstBalance: number | null = null
  let totalPnl = 0

  for (const r of rows) {
    const id = Number(r.id)
    const result = String(r.result) as "WIN" | "LOSS" | "SCRATCH"
    const shares = Number(r.shares ?? 0)
    const cost = Number(r.cost ?? 0)
    const pnl = Number(r.pnl ?? 0)
    const balanceAfter = Number(r.balance_after ?? 0)
    totalPnl += pnl

    // Identity A — per-trade PnL.
    const expectedPnl = Math.round((bookedPayout({ result, shares, cost }) - cost) * 10000) / 10000
    if (Math.abs(pnl - expectedPnl) > 0.01) {
      pnlViolations.push(
        `#${id}: booked pnl $${pnl.toFixed(4)} but ${result} × ${shares} shares @ cost $${cost.toFixed(4)} implies $${expectedPnl.toFixed(4)}`,
      )
    }

    // Identity B — balance chain (skip repaired rows, same as the online sweep).
    const isRepaired = String(r.explanation ?? "").includes("settlementRepair")
    if (prevBalance !== null && !isRepaired) {
      const delta = Math.round((balanceAfter - prevBalance) * 10000) / 10000
      if (Math.abs(delta - pnl) > 0.01) {
        chainBreaks.push(
          `#${id}: balance moved ${delta >= 0 ? "+" : ""}$${delta.toFixed(4)} ($${prevBalance.toFixed(4)} → $${balanceAfter.toFixed(4)}) but booked pnl is ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`,
        )
      }
    }
    if (firstBalance === null) firstBalance = Math.round((balanceAfter - pnl) * 10000) / 10000
    prevBalance = balanceAfter

    // Identity D — a shares count deviating from an integral pattern must be
    // explained. Without a stored config history we flag ONLY rows whose
    // explanation admits a deviation marker is missing when the sizing audit
    // says one was requested.
    const explanation = String(r.explanation ?? "")
    if (explanation.includes('"sizing"')) {
      try {
        const parsed = JSON.parse(explanation) as { sizing?: { requestedShares?: number }; partialFill?: unknown }
        const requested = parsed.sizing?.requestedShares
        if (typeof requested === "number" && shares < requested && !parsed.partialFill) {
          sizingDeviations.push(`#${id}: booked ${shares} shares but sizing audit requested ${requested} with NO partialFill block`)
        }
      } catch {
        /* non-JSON explanation — legacy row */
      }
    }
  }

  const bankroll = new Bankroll(mode)
  const pool = Math.round((bankroll.balance + bankroll.dustReserve) * 10000) / 10000
  const ledgerEnd = prevBalance
  const bankrollDrift = ledgerEnd !== null ? Math.round((pool - ledgerEnd) * 10000) / 10000 : null

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          mode,
          settled: rows.length,
          pnlViolations,
          chainBreaks,
          sizingDeviations,
          bankroll: { startLedger: firstBalance, endLedger: ledgerEnd, totalPnl: Math.round(totalPnl * 10000) / 10000, livePool: pool, driftUsd: bankrollDrift },
        },
        null,
        2,
      ),
    )
    return
  }

  const line = "=".repeat(78)
  console.log(line)
  console.log(`ACCOUNTING RECONCILIATION — ${mode} — ${rows.length} settled trades (offline, full history)`)
  console.log(line)
  console.log(`  Identity A (per-trade PnL):      ${pnlViolations.length === 0 ? "PASS" : `${pnlViolations.length} VIOLATION(S)`}`)
  for (const v of pnlViolations) console.log(`    - ${v}`)
  console.log(`  Identity B (balance chain):      ${chainBreaks.length === 0 ? "PASS" : `${chainBreaks.length} BREAK(S)`}`)
  for (const v of chainBreaks) console.log(`    - ${v}`)
  console.log(`  Identity D (sizing conformance): ${sizingDeviations.length === 0 ? "PASS" : `${sizingDeviations.length} UNEXPLAINED`}`)
  for (const v of sizingDeviations) console.log(`    - ${v}`)
  console.log(`\n  BANKROLL PROGRESSION`)
  console.log(`    Ledger start balance:   ${firstBalance !== null ? `$${firstBalance.toFixed(4)}` : "n/a (no settled trades)"}`)
  console.log(`    Ledger end balance:     ${ledgerEnd !== null ? `$${ledgerEnd.toFixed(4)}` : "n/a"}`)
  console.log(`    Sum of booked PnL:      $${totalPnl.toFixed(4)}`)
  console.log(`    Live bankroll pool:     $${pool.toFixed(4)} (balance + dust)`)
  console.log(
    `    Identity C (agreement): ${bankrollDrift === null ? "n/a" : Math.abs(bankrollDrift) <= 0.01 ? "PASS" : `DRIFT $${bankrollDrift.toFixed(4)} (open positions legitimately explain a debit-sized gap)`}`,
  )
  console.log("")
}

async function main() {
  if (doAccounting) {
    await accountingMain()
    return
  }
  const { recentTrades } = await import("../lib/v2/engine/db")
  const { fetchOfficialResolution } = await import("../lib/v2/engine/feeds/market-discovery")
  const { computeExpected, repairTrade } = await import("../lib/v2/engine/settlement-repair")
  const mode = modeArg as import("../lib/v2/engine/types").PipelineMode

  const trades = recentTrades(mode, limit).filter((t) => t.status === "SETTLED")
  // Oldest first so the balance-chain walk and the report read chronologically.
  trades.sort((a, b) => a.id - b.id)

  const rows: AuditRowResult[] = []
  const failClasses = new Map<string, number>()
  let totalPnlError = 0
  let scratchWithOfficial = 0
  let repairs = 0

  console.error(`Auditing ${trades.length} settled ${mode} trades from ${fullPath}${doRepair ? " [REPAIR MODE]" : " [read-only]"}…`)

  for (const t of trades) {
    // Rate-limit official lookups: Gamma tolerates ~5 rps comfortably.
    await new Promise((r) => setTimeout(r, 250))
    let official: import("../lib/v2/engine/types").TradeSide | null = null
    try {
      official = await fetchOfficialResolution(t.slotEndMs)
    } catch {
      official = null
    }

    if (official === null) {
      // No official evidence: SCRATCH is legitimate; WIN/LOSS can't be checked.
      rows.push({
        id: t.id,
        marketId: t.marketId,
        side: t.side,
        booked: t.result,
        bookedPnl: t.pnl,
        official: null,
        expected: null,
        expectedPnl: null,
        status: "UNRESOLVED",
        reason: "official resolution unavailable (market too old, unlisted, or not yet resolved) — cannot verify",
      })
      continue
    }

    const expected = computeExpected(t, official)
    const resultOk = t.result === expected.result
    const pnlOk = resultOk && Math.abs(t.pnl - expected.pnl) < 0.005
    if (t.result === "SCRATCH") scratchWithOfficial++

    if (resultOk && pnlOk) {
      rows.push({
        id: t.id,
        marketId: t.marketId,
        side: t.side,
        booked: t.result,
        bookedPnl: t.pnl,
        official,
        expected: expected.result,
        expectedPnl: expected.pnl,
        status: "PASS",
        reason: "booked result and PnL match the official resolution",
      })
      continue
    }

    const failClass = !resultOk
      ? t.result === "SCRATCH"
        ? "SCRATCH-should-be-" + expected.result
        : `${t.result}-should-be-${expected.result}`
      : "correct-label-wrong-pnl"
    failClasses.set(failClass, (failClasses.get(failClass) ?? 0) + 1)
    totalPnlError += Math.abs(t.pnl - expected.pnl)

    const row: AuditRowResult = {
      id: t.id,
      marketId: t.marketId,
      side: t.side,
      booked: t.result,
      bookedPnl: t.pnl,
      official,
      expected: expected.result,
      expectedPnl: expected.pnl,
      status: "FAIL",
      reason: !resultOk
        ? `booked ${t.result} but official winner is ${official} (bet ${t.side} → correct result ${expected.result}); booked PnL $${t.pnl.toFixed(4)}, correct $${expected.pnl.toFixed(4)}`
        : `result label correct but PnL wrong: booked $${t.pnl.toFixed(4)}, correct $${expected.pnl.toFixed(4)}`,
    }

    if (doRepair) {
      const outcome = repairTrade(
        {
          id: t.id,
          tradeUid: t.tradeUid,
          marketId: t.marketId,
          slotEndMs: t.slotEndMs,
          side: t.side,
          price: t.price,
          shares: t.shares,
          cost: t.cost,
          result: t.result as "WIN" | "LOSS" | "SCRATCH",
          pnl: t.pnl,
          mode,
        },
        official,
        { requestedBy: "audit-ledger-cli" },
      )
      row.repaired = outcome.applied
      row.repairReason = outcome.reason
      if (outcome.applied) repairs++
    }
    rows.push(row)
  }

  // ---- Balance-chain audit (report-only, excludes repaired rows). ----
  const chain = trades.filter((t) => !(t.explanation ?? "").includes("settlementRepair"))
  const chainBreaks: string[] = []
  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1]
    const cur = chain[i]
    const actualDelta = Math.round((cur.balanceAfter - prev.balanceAfter) * 10000) / 10000
    if (Math.abs(actualDelta - cur.pnl) > 0.01) {
      chainBreaks.push(
        `#${cur.id} (${cur.marketId}): balance moved ${actualDelta >= 0 ? "+" : ""}$${actualDelta.toFixed(4)} but booked PnL is ${cur.pnl >= 0 ? "+" : ""}$${cur.pnl.toFixed(4)}`,
      )
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ rows, chainBreaks, summary: { total: rows.length, repairs } }, null, 2))
    return
  }

  // ---- Report ----
  const line = "=".repeat(78)
  console.log(line)
  console.log(`LEDGER AUDIT — ${mode} — ${rows.length} settled trades`)
  console.log(line)
  for (const r of rows) {
    const tag = r.status === "PASS" ? "PASS " : r.status === "FAIL" ? "FAIL " : "UNRES"
    console.log(`  [${tag}] #${String(r.id).padEnd(5)} ${r.side.padEnd(4)} booked ${r.booked.padEnd(7)} pnl $${r.bookedPnl.toFixed(2).padStart(8)}  ${r.reason}`)
    if (r.repaired !== undefined) console.log(`          ${r.repaired ? "REPAIRED" : "repair skipped"}: ${r.repairReason}`)
  }

  const pass = rows.filter((r) => r.status === "PASS").length
  const fail = rows.filter((r) => r.status === "FAIL").length
  const unresolved = rows.filter((r) => r.status === "UNRESOLVED").length

  console.log(`\n${line}`)
  console.log("SUMMARY")
  console.log(line)
  console.log(`  PASS:        ${pass}`)
  console.log(`  FAIL:        ${fail}`)
  console.log(`  UNRESOLVED:  ${unresolved} (official result not retrievable — not necessarily wrong)`)
  if (failClasses.size > 0) {
    console.log(`  Failure classes:`)
    for (const [k, v] of failClasses) console.log(`    - ${k}: ${v}`)
  }
  console.log(`  SCRATCH with official result available: ${scratchWithOfficial} (should be repaired to WIN/LOSS)`)
  console.log(`  Total absolute PnL error: $${totalPnlError.toFixed(4)}`)
  if (doRepair) console.log(`  Repairs applied: ${repairs}`)
  console.log(`  Balance-chain breaks: ${chainBreaks.length}`)
  for (const b of chainBreaks) console.log(`    - ${b}`)
  if (!doRepair && fail > 0) {
    console.log(`\n  ${fail} trade(s) FAILED with official evidence. Re-run with --repair to fix them:`)
    console.log(`    pnpm audit-ledger --db ${dbPath} --repair`)
  }
  console.log("")
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  },
)
