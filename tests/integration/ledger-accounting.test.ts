import { beforeAll, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import {
  insertTrade,
  kvGet,
  kvSet,
  openTrade,
  recentTrades,
  settleTrade,
  updateSettledBalance,
  closeOrphanedOpenTrades,
  flushWriteQueueSync,
} from "@/lib/v2/engine/db"

// ------------------------------------------------------------
// Regression tests for the ledger accounting audit:
//
//   1. SETTLE-ONCE IDEMPOTENCY — settleTrade only updates rows still OPEN, so
//      a second settle attempt (early-resolution + rollover race) can never
//      overwrite a committed WIN/LOSS/SCRATCH or trigger a double bankroll
//      credit (the caller credits only when settleTrade reports 1 row).
//
//   2. ORPHAN SCRATCH REFUND — rows still OPEN at boot are closed SCRATCH with
//      the entry cost REFUNDED to the mode's bankroll kv. The old behavior
//      (pnl=0, no refund) silently destroyed pool money on every restart with
//      an open position.
//
//   3. EXPLANATION PERSISTENCE — every trade row can carry a permanent JSON
//      audit record (why it opened / why it settled / PnL math), and settle
//      merges its fragment into the open-time fragment.
// ------------------------------------------------------------

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

function openRow(over: Partial<Parameters<typeof openTrade>[0]> = {}): number {
  return openTrade({
    marketId: `mkt-${Math.random().toString(36).slice(2)}`,
    slotEndMs: Date.now(),
    side: "UP",
    price: 0.9,
    shares: 10,
    cost: 9,
    balanceAfter: 991,
    mode: "PAPER_V1",
    ...over,
  })
}

describe("settleTrade — settle-once idempotency", () => {
  it("settles an OPEN row exactly once and reports 1 row changed", () => {
    const id = openRow()
    const first = settleTrade({ id, result: "WIN", pnl: 1, balanceAfter: 1001, markPrice: 1 })
    expect(first).toBe(1)
    const row = recentTrades("PAPER_V1", 500).find((t) => t.id === id)!
    expect(row.result).toBe("WIN")
    expect(row.status).toBe("SETTLED")
  })

  it("REGRESSION: a second settle attempt cannot overwrite a committed result (returns 0 rows)", () => {
    const id = openRow()
    expect(settleTrade({ id, result: "WIN", pnl: 1, balanceAfter: 1001, markPrice: 1 })).toBe(1)
    // Race: another path tries to settle the same row as a LOSS.
    const second = settleTrade({ id, result: "LOSS", pnl: -9, balanceAfter: 992, markPrice: 0 })
    expect(second).toBe(0)
    const row = recentTrades("PAPER_V1", 500).find((t) => t.id === id)!
    expect(row.result).toBe("WIN")
    expect(row.pnl).toBe(1)
  })
})

describe("orphaned OPEN rows — SCRATCH with cost refund", () => {
  it("REGRESSION: boot-time orphan recovery REFUNDS the entry cost to the mode bankroll", () => {
    // Seed a bankroll balance and an OPEN row whose cost was debited from it.
    const balKey = "bankroll:PAPER_V1:balance"
    kvSet(balKey, "991") // 1000 - 9 cost debited at fill
    const id = openRow({ cost: 9 })

    closeOrphanedOpenTrades()

    const row = recentTrades("PAPER_V1", 500).find((t) => t.id === id)!
    expect(row.status).toBe("SETTLED")
    expect(row.result).toBe("SCRATCH")
    expect(row.pnl).toBe(0)
    // The refund is the point: balance must be back to 1000, not stuck at 991.
    expect(Number(kvGet(balKey))).toBe(1000)
    // And the row carries a recovery explanation.
    expect(row.explanation).toBeTruthy()
    const exp = JSON.parse(row.explanation!) as Record<string, string>
    expect(exp.settlement).toContain("SCRATCH")
    expect(exp.recovery).toContain("refund")
  })

  it("refunds multiple orphaned rows cumulatively", () => {
    const balKey = "bankroll:PAPER_V1:balance"
    kvSet(balKey, "982") // 1000 - two 9-cost fills
    const a = openRow({ cost: 9 })
    const b = openRow({ cost: 9 })
    closeOrphanedOpenTrades()
    expect(Number(kvGet(balKey))).toBe(1000)
    for (const id of [a, b]) {
      const row = recentTrades("PAPER_V1", 500).find((t) => t.id === id)!
      expect(row.result).toBe("SCRATCH")
    }
  })
})

describe("explanation persistence", () => {
  it("persists an open-time explanation and MERGES the settle-time fragment into it", () => {
    const id = openRow({
      explanation: JSON.stringify({ entry: "trigger $0.90 hit — UP won the race", costCalc: "10 × $0.90 = $9.00" }),
    })
    settleTrade({
      id,
      result: "WIN",
      pnl: 1,
      balanceAfter: 1001,
      markPrice: 1,
      explanation: JSON.stringify({ settlement: "WIN — official winner UP", pnlCalc: "$10.00 − $9.00 = +$1.00" }),
    })
    const row = recentTrades("PAPER_V1", 500).find((t) => t.id === id)!
    const exp = JSON.parse(row.explanation!) as Record<string, string>
    // Both the open-time and settle-time fragments survive.
    expect(exp.entry).toContain("race")
    expect(exp.costCalc).toContain("$9.00")
    expect(exp.settlement).toContain("WIN")
    expect(exp.pnlCalc).toContain("+$1.00")
  })

  it("insertTrade persists an explanation on directly-settled rows", () => {
    insertTrade({
      marketId: "mkt-direct",
      slotEndMs: Date.now(),
      side: "DOWN",
      price: 0.5,
      shares: 10,
      cost: 5,
      result: "LOSS",
      pnl: -5,
      balanceAfter: 995,
      dustSaved: 0,
      mode: "PAPER_V1",
      explanation: JSON.stringify({ settlement: "LOSS — bet DOWN, winner UP" }),
    })
    flushWriteQueueSync() // Ensure async write completes before assertion
    const row = recentTrades("PAPER_V1", 500).find((t) => t.marketId === "mkt-direct")!
    expect(JSON.parse(row.explanation!).settlement).toContain("LOSS")
  })

  it("updateSettledBalance stamps the post-credit balance on a SETTLED row only", () => {
    const id = openRow()
    // Not yet settled → stamp must not apply.
    updateSettledBalance(id, 1234)
    let row = recentTrades("PAPER_V1", 500).find((t) => t.id === id)!
    expect(row.balanceAfter).not.toBe(1234)
    settleTrade({ id, result: "WIN", pnl: 1, balanceAfter: 0, markPrice: 1 })
    updateSettledBalance(id, 1234)
    row = recentTrades("PAPER_V1", 500).find((t) => t.id === id)!
    expect(row.balanceAfter).toBe(1234)
  })
})

describe("schema — explanation column exists and survives reads", () => {
  it("recentTrades returns the explanation field for every row", () => {
    const rows = recentTrades("PAPER_V1", 5)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect("explanation" in r).toBe(true)
  })
})
