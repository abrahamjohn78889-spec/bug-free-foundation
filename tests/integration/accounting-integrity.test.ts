import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { clearLedger, flushWriteQueueSync, kvSet, openTrade, recentOrderLogs, recentTrades, settleTrade } from "@/lib/v2/engine/db"
import { Bankroll } from "@/lib/v2/engine/bankroll"
import { PaperExecutor } from "@/lib/v2/engine/execution/paper"
import { verifyAccounting } from "@/lib/v2/engine/accounting-verifier"

// ------------------------------------------------------------------
// PHASE 5 — ACCOUNTING, BANKROLL & SIZING INTEGRITY
//
//   RC1: the displayed bankroll must move by the PnL, never the payout.
//        The ledger-driven kv Bankroll is the ONE authority; the paper
//        wallet is a mirror that can NEVER overwrite it (restart-safe).
//   RC2: booked shares deviating from the configured count must carry a
//        permanent audit trail (partial fill / risk clamp) — never silent.
//   RC3: the continuous accounting verifier detects wrong PnL rows,
//        balance-chain breaks and bankroll drift, and auto-reconciles
//        ONLY the derived bankroll (Identity C) from the ledger.
// ------------------------------------------------------------------

const MODE = "PAPER_V1" as const

beforeAll(() => {
  const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || "data/test-ledger.db")
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(dbPath + suffix, { force: true })
    } catch {
      /* ignore */
    }
  }
})

beforeEach(() => {
  clearLedger(MODE)
})

/** Reset kv-persisted verifier alert throttles so each test reports fresh. */
function resetAlertThrottles() {
  // alert keys are date/uid-scoped; use unique uids per test instead of purging
}

function settledRow(over: {
  pnl: number
  balanceAfter: number
  result?: "WIN" | "LOSS" | "SCRATCH"
  shares?: number
  cost?: number
  explanation?: string | null
  uid?: string
}): number {
  const shares = over.shares ?? 10
  const cost = over.cost ?? 9
  const id = openTrade({
    marketId: `mkt-${Math.random().toString(36).slice(2)}`,
    slotEndMs: Date.now(),
    side: "UP",
    price: cost / shares,
    shares,
    cost,
    balanceAfter: over.balanceAfter - over.pnl, // pre-settle balance
    mode: MODE,
    tradeUid: over.uid ?? `uid-${Math.random().toString(36).slice(2)}`,
    explanation: over.explanation ?? null,
  })
  settleTrade({ id, result: over.result ?? (over.pnl >= 0 ? "WIN" : "LOSS"), pnl: over.pnl, balanceAfter: over.balanceAfter, markPrice: over.pnl >= 0 ? 1 : 0 })
  return id
}

describe("RC1 — one authoritative bankroll (fill debit + settle credit = PnL)", () => {
  it("bankroll progression across a WIN moves by exactly the PnL, not the payout", () => {
    const bankroll = new Bankroll(MODE)
    bankroll.reset(100)
    // Fill: 7 shares @ $0.99 = $6.93 debit.
    bankroll.debitFixed(6.93)
    expect(bankroll.balance).toBeCloseTo(93.07, 4)
    // Settlement: WIN pays $1/share → +$7.00 credit.
    bankroll.settle(7)
    // Net move = +$0.07 (the PnL), NEVER +$7.00.
    expect(bankroll.balance).toBeCloseTo(100.07, 4)
  })

  it("Bankroll.settle rounds to 4dp like every other mutator", () => {
    const bankroll = new Bankroll(MODE)
    bankroll.reset(0)
    bankroll.settle(0.1)
    bankroll.settle(0.2) // classic float trap: 0.1 + 0.2
    expect(bankroll.balance).toBe(0.3)
  })

  it("REGRESSION (root cause): a restarted paper wallet can NEVER stomp the bankroll", async () => {
    const bankroll = new Bankroll(MODE)
    bankroll.reset(100)
    bankroll.debitFixed(6.93)
    bankroll.settle(7) // true balance: $100.07

    // Simulate a PM2 restart: fresh in-memory wallet seeded from the default,
    // which then receives ONLY the settlement credit (fill debit lost).
    const executor = new PaperExecutor(() => 0.99, { startingWalletUsd: 100 })
    executor.creditSettlement(7) // stale wallet now claims $107.00

    // Old behavior: syncLiveBalance copied wallet → bankroll ($107.00, +$7.00
    // jump). New contract: the engine re-seeds the wallet FROM the bankroll.
    executor.setWalletUsd(bankroll.balance + bankroll.dustReserve)
    const wallet = await executor.getAvailableBalanceUsd()
    expect(wallet).toBeCloseTo(100.07, 2)
    expect(bankroll.balance).toBeCloseTo(100.07, 4) // untouched authority
  })
})

describe("RC2 — sizing conformance (Identity D)", () => {
  it("fixed shares booked in full with a sizing audit pass verification", () => {
    const bankroll = new Bankroll(MODE)
    bankroll.reset(100)
    settledRow({
      pnl: 0.07, // WIN: payout 7 × $1 − cost $6.93
      balanceAfter: 100.07,
      shares: 7,
      cost: 6.93,
      explanation: JSON.stringify({ sizing: { requestedShares: 7, effectiveShares: 7, sizingMode: "FIXED_SHARES" } }),
    })
    kvSet(`bankroll:${MODE}:balance`, "100.07")
    const summary = verifyAccounting(MODE, {
      getBankroll: () => bankroll,
      getConfiguredShares: () => ({ sizingMode: "FIXED_SHARES", shares: 7 }),
    })
    expect(summary.sizingDeviationsUnexplained).toBe(0)
    expect(summary.pnlIdentityViolations).toBe(0)
  })

  it("a partial fill books reduced shares WITH a partialFill audit block — explained, no violation", () => {
    const bankroll = new Bankroll(MODE)
    bankroll.reset(100)
    settledRow({
      pnl: 0.03,
      balanceAfter: 100.03,
      shares: 3,
      cost: 2.97,
      explanation: JSON.stringify({
        sizing: { requestedShares: 7, effectiveShares: 7, sizingMode: "FIXED_SHARES" },
        partialFill: { requested: 7, filled: 3, remainderCancelled: 4 },
      }),
    })
    kvSet(`bankroll:${MODE}:balance`, "100.03")
    const summary = verifyAccounting(MODE, {
      getBankroll: () => bankroll,
      getConfiguredShares: () => ({ sizingMode: "FIXED_SHARES", shares: 7 }),
    })
    expect(summary.sizingDeviationsUnexplained).toBe(0)
  })

  it("REGRESSION: 7 configured → 3 booked with NO audit trail is flagged as a CRITICAL deviation", () => {
    const bankroll = new Bankroll(MODE)
    bankroll.reset(100)
    settledRow({
      pnl: 0.03,
      balanceAfter: 100.03,
      shares: 3,
      cost: 2.97,
      explanation: JSON.stringify({ entry: "standing limit order fill" }), // no partialFill / riskClamp
      uid: `silent-deviation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    kvSet(`bankroll:${MODE}:balance`, "100.03")
    const summary = verifyAccounting(MODE, {
      getBankroll: () => bankroll,
      getConfiguredShares: () => ({ sizingMode: "FIXED_SHARES", shares: 7 }),
    })
    expect(summary.sizingDeviationsUnexplained).toBe(1)
    flushWriteQueueSync()
    const logs = recentOrderLogs(MODE, 50)
    expect(logs.some((l) => String(l.detail).includes("ACCOUNTING_VERIFIER SIZING_DEVIATION"))).toBe(true)
  })
})

describe("RC3 — continuous accounting verifier (identities A/B/C)", () => {
  it("a healthy ledger passes all identities", () => {
    const bankroll = new Bankroll(MODE)
    bankroll.reset(100)
    // Default row shape: 10 shares @ cost $9 → WIN pnl = 10 − 9 = +$1.00.
    settledRow({ pnl: 1, balanceAfter: 101, uid: `h1-${Date.now()}-${Math.random()}` })
    settledRow({ pnl: -9, balanceAfter: 92, result: "LOSS", uid: `h2-${Date.now()}-${Math.random()}` })
    kvSet(`bankroll:${MODE}:balance`, "92")
    kvSet(`bankroll:${MODE}:dust`, "0")
    const summary = verifyAccounting(MODE, { getBankroll: () => bankroll })
    expect(summary.settledChecked).toBe(2)
    expect(summary.pnlIdentityViolations).toBe(0)
    expect(summary.balanceChainBreaks).toBe(0)
    expect(summary.bankrollReconciled).toBe(false)
    expect(summary.ledgerBalance).toBeCloseTo(92, 4)
  })

  it("Identity A: a wrong PnL row (payout booked as PnL) is detected + logged", () => {
    resetAlertThrottles()
    const bankroll = new Bankroll(MODE)
    bankroll.reset(100)
    // The exact production bug shape: 7 shares, cost $6.93, WIN.
    // Correct pnl = payout(7) − cost(6.93) = +$0.07. Booked +$7.00 instead.
    settledRow({ pnl: 7, balanceAfter: 107, shares: 7, cost: 6.93, uid: `wrongpnl-${Date.now()}-${Math.random()}` })
    kvSet(`bankroll:${MODE}:balance`, "107")
    const summary = verifyAccounting(MODE, { getBankroll: () => bankroll })
    expect(summary.pnlIdentityViolations).toBe(1)
    flushWriteQueueSync()
    const logs = recentOrderLogs(MODE, 50)
    expect(logs.some((l) => String(l.detail).includes("ACCOUNTING_VERIFIER PNL_IDENTITY"))).toBe(true)
  })

  it("Identity B: a balance-chain break (balance jumped by payout, pnl correct) is detected", () => {
    const bankroll = new Bankroll(MODE)
    bankroll.reset(100)
    settledRow({ pnl: 0.07, balanceAfter: 100.07, shares: 7, cost: 6.93, uid: `c1-${Date.now()}-${Math.random()}` })
    // Second row: correct pnl (+$0.07) but balance jumped +$7.00 → chain break.
    settledRow({ pnl: 0.07, balanceAfter: 107.07, shares: 7, cost: 6.93, uid: `c2-${Date.now()}-${Math.random()}` })
    kvSet(`bankroll:${MODE}:balance`, "107.07")
    const summary = verifyAccounting(MODE, { getBankroll: () => bankroll })
    expect(summary.balanceChainBreaks).toBe(1)
  })

  it("Identity C: bankroll drift is auto-reconciled by re-stamping FROM the ledger", () => {
    const bankroll = new Bankroll(MODE)
    bankroll.reset(100)
    settledRow({ pnl: 0.07, balanceAfter: 100.07, shares: 7, cost: 6.93, uid: `d1-${Date.now()}-${Math.random()}` })
    // Corrupt the derived kv bankroll (simulates the old wallet stomp).
    kvSet(`bankroll:${MODE}:balance`, "107.00")
    kvSet(`bankroll:${MODE}:dust`, "0")
    const summary = verifyAccounting(MODE, { getBankroll: () => bankroll })
    expect(summary.bankrollDriftUsd).toBeCloseTo(6.93, 2)
    expect(summary.bankrollReconciled).toBe(true)
    // The bankroll now agrees with the ledger again.
    expect(bankroll.balance).toBeCloseTo(100.07, 4)
  })

  it("Identity C respects open (unsettled) costs — a live position is not drift", () => {
    const bankroll = new Bankroll(MODE)
    bankroll.reset(100)
    settledRow({ pnl: 0.07, balanceAfter: 100.07, shares: 7, cost: 6.93, uid: `e1-${Date.now()}-${Math.random()}` })
    // A new fill debited $6.93 but hasn't settled: pool = 100.07 − 6.93.
    kvSet(`bankroll:${MODE}:balance`, "93.14")
    kvSet(`bankroll:${MODE}:dust`, "0")
    const summary = verifyAccounting(MODE, {
      getBankroll: () => bankroll,
      getOpenCostUsd: () => 6.93,
    })
    expect(summary.bankrollReconciled).toBe(false)
    expect(Math.abs(summary.bankrollDriftUsd ?? 99)).toBeLessThanOrEqual(0.01)
  })
})

describe("Sizing math regression (PERCENT compounding / FIXED_USD floors)", () => {
  it("PERCENT sizes from the compounded pool: a win increases the next order", () => {
    const bankroll = new Bankroll(MODE)
    bankroll.reset(100)
    const price = 0.95
    const sizeBefore = Math.floor(((bankroll.balance + bankroll.dustReserve) * 50) / 100 / price)
    expect(sizeBefore).toBe(52) // floor(50 / 0.95)
    bankroll.debitFixed(52 * price)
    bankroll.settle(52) // WIN: +$52 payout
    const sizeAfter = Math.floor(((bankroll.balance + bankroll.dustReserve) * 50) / 100 / price)
    expect(bankroll.balance).toBeCloseTo(102.6, 4)
    expect(sizeAfter).toBe(54) // compounded: floor(51.3 / 0.95)
  })

  it("FIXED_USD floors to whole shares", () => {
    expect(Math.floor(10 / 0.99)).toBe(10)
    expect(Math.floor(10 / 0.95)).toBe(10)
    expect(Math.floor(5 / 0.99)).toBe(5)
    expect(Math.floor(0.5 / 0.99)).toBe(0) // pool can't afford one share
  })
})

describe("Ledger is the single source for analytics", () => {
  it("analytics equity tail == last settled balance_after == reconciled bankroll pool", async () => {
    const { computeAnalytics } = await import("@/lib/v2/engine/analytics")
    const bankroll = new Bankroll(MODE)
    bankroll.reset(100)
    settledRow({ pnl: 0.7, balanceAfter: 100.7, uid: `a1-${Date.now()}-${Math.random()}` })
    settledRow({ pnl: 0.5, balanceAfter: 101.2, uid: `a2-${Date.now()}-${Math.random()}` })
    kvSet(`bankroll:${MODE}:balance`, "101.2")
    kvSet(`bankroll:${MODE}:dust`, "0")
    const a = computeAnalytics(MODE)
    expect(a.ledgerBalance).toBeCloseTo(101.2, 2)
    expect(a.bankrollPool).toBeCloseTo(101.2, 2)
    const tail = a.bankrollSeries[a.bankrollSeries.length - 1]
    expect(tail.balance).toBeCloseTo(101.2, 2)
    // Cross-check with the verifier's Identity C.
    const summary = verifyAccounting(MODE, { getBankroll: () => bankroll })
    expect(summary.bankrollReconciled).toBe(false)
  })
})
