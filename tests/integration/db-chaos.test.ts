// ============================================================================
// DATABASE CHAOS TESTS — SQLite contention, crash recovery, maintenance
// ============================================================================
// Simulates the failure modes a months-long VPS deployment will hit:
//  • concurrent writer holding a lock (SQLITE_BUSY) → busy_timeout must absorb
//  • process crash leaving OPEN trades → closeOrphanedOpenTrades must recover
//  • unbounded order_log growth → runDbMaintenance must prune
//  • kv persistence across simulated restart (new connection)
// ============================================================================

import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import {
  closeOrphanedOpenTrades,
  dailyOrderSubmissions,
  dailyRiskStats,
  insertOrderLog,
  kvGet,
  kvSet,
  openTrade,
  runDbMaintenance,
  settleTrade,
  tradeStats,
  flushWriteQueueSync,
} from "@/lib/v2/engine/db"

const MODE = "PAPER_V1" as const
// Must match the engine's DB — setup-db.ts assigns a per-worker path.
const DB_FILE = process.env.DB_PATH || "data/test-ledger.db"

describe("SQLite resilience under chaos", () => {
  it("kv values persist and overwrite correctly (restart persistence)", () => {
    kvSet("chaos:test-key", "value-1")
    expect(kvGet("chaos:test-key")).toBe("value-1")
    kvSet("chaos:test-key", "value-2")
    expect(kvGet("chaos:test-key")).toBe("value-2")
    expect(kvGet("chaos:missing-key")).toBeNull()
  })

  it("survives a concurrent writer holding the database (SQLITE_BUSY chaos)", async () => {
    // better-sqlite3 is synchronous — a same-process lock contest would just
    // deadlock the event loop. Real contention comes from ANOTHER process
    // (e.g. a sqlite3 CLI inspecting the DB), so simulate exactly that: a
    // child process grabs an IMMEDIATE lock for 300ms while we write.
    const { spawn } = await import("node:child_process")
    const child = spawn(process.execPath, [
      "-e",
      `const D=require("better-sqlite3");const db=new D(${JSON.stringify(DB_FILE)});db.prepare("BEGIN IMMEDIATE").run();setTimeout(()=>{db.prepare("COMMIT").run();db.close();},300);`,
    ])
    // Give the child time to acquire the lock.
    await new Promise((r) => setTimeout(r, 150))
    // Main connection has busy_timeout=5000: this write must WAIT for the
    // child's commit and then succeed — not throw SQLITE_BUSY.
    expect(() => kvSet("chaos:busy-test", "written-during-contention")).not.toThrow()
    expect(kvGet("chaos:busy-test")).toBe("written-during-contention")
    await new Promise((r) => child.on("exit", r))
  })

  it("recovers orphaned OPEN trades after a simulated process crash", () => {
    // Simulate: engine opened a trade, then the process died before settling.
    openTrade({
      mode: MODE,
      marketId: "chaos-crash-market",
      side: "UP",
      price: 0.5,
      shares: 10,
      cost: 5,
      balanceAfter: 95,
      slotEndMs: Date.now() - 60_000, // slot already over — trade is orphaned
    })
    closeOrphanedOpenTrades()
    // After recovery there must be no OPEN trades left.
    const db = new Database(DB_FILE, { readonly: true })
    const open = db.prepare("SELECT COUNT(*) AS n FROM trades WHERE status = 'OPEN'").get() as { n: number }
    db.close()
    expect(open.n).toBe(0)
  })

  it("runDbMaintenance prunes old order_log rows but never touches trades", () => {
    // Insert an ancient order_log row (45 days old) and a fresh one.
    insertOrderLog({ mode: MODE, event: "SUBMITTED", marketId: "chaos-old", price: 0.5, shares: 1 })
    flushWriteQueueSync() // Ensure writes complete before reopening
    const db = new Database(DB_FILE)
    db.prepare("UPDATE order_log SET ts_ms = ? WHERE market_id = 'chaos-old'").run(Date.now() - 45 * 86_400_000)
    db.close()
    insertOrderLog({ mode: MODE, event: "SUBMITTED", marketId: "chaos-new", price: 0.5, shares: 1 })
    flushWriteQueueSync() // Ensure writes complete before querying

    const before = tradeStats(MODE)
    const summary = runDbMaintenance(30)
    expect(summary).toContain("pruned")

    const db2 = new Database(DB_FILE, { readonly: true })
    const oldRows = db2.prepare("SELECT COUNT(*) AS n FROM order_log WHERE market_id = 'chaos-old'").get() as {
      n: number
    }
    const newRows = db2.prepare("SELECT COUNT(*) AS n FROM order_log WHERE market_id = 'chaos-new'").get() as {
      n: number
    }
    db2.close()
    expect(oldRows.n).toBe(0) // pruned
    expect(newRows.n).toBeGreaterThanOrEqual(1) // retained
    // Trades ledger untouched by maintenance.
    const after = tradeStats(MODE)
    expect(after.totalPnl).toBe(before.totalPnl)
  })

  it("dailyRiskStats counts only today's settled trades (daily-loss breaker input)", () => {
    const id = openTrade({
      mode: MODE,
      marketId: "chaos-daily-pnl",
      side: "UP",
      price: 0.5,
      shares: 10,
      cost: 5,
      balanceAfter: 95,
      slotEndMs: Date.now(),
    })
    settleTrade({ id, result: "LOSS", pnl: -5, balanceAfter: 90, markPrice: 0 })
    const stats = dailyRiskStats(MODE)
    expect(stats.settledTrades).toBeGreaterThanOrEqual(1)
    expect(stats.realizedPnl).toBeLessThanOrEqual(-5)
  })

  it("dailyOrderSubmissions counts only SUBMITTED events from today (rate-cap input)", () => {
    const before = dailyOrderSubmissions(MODE)
    insertOrderLog({ mode: MODE, event: "SUBMITTED", marketId: "chaos-rate", price: 0.5, shares: 1 })
    insertOrderLog({ mode: MODE, event: "CANCELLED", marketId: "chaos-rate" })
    flushWriteQueueSync() // Ensure writes complete before querying
    const after = dailyOrderSubmissions(MODE)
    expect(after).toBe(before + 1) // CANCELLED must not count toward the cap
  })

  it("duplicate settlement calls do not double-count PnL (duplicate message chaos)", () => {
    const id = openTrade({
      mode: MODE,
      marketId: "chaos-dup-settle",
      side: "UP",
      price: 0.5,
      shares: 10,
      cost: 5,
      balanceAfter: 95,
      slotEndMs: Date.now(),
    })
    const before = tradeStats(MODE)
    settleTrade({ id, result: "WIN", pnl: 5, balanceAfter: 100, markPrice: 1 })
    // Duplicate settle (e.g. duplicate WS message triggering a second path):
    // settleTrade is an UPDATE by primary key — running it twice must leave
    // the row with pnl=5 once, never a second row or doubled PnL.
    settleTrade({ id, result: "WIN", pnl: 5, balanceAfter: 100, markPrice: 1 })
    const after = tradeStats(MODE)
    // PnL must increase by exactly 5, not 10.
    expect(Math.round((after.totalPnl - before.totalPnl) * 100) / 100).toBe(5)
  })
})
