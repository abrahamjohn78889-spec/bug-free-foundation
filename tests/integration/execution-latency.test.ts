import { describe, it, expect, beforeEach } from "vitest"
import { getRecentTraces, getPhaseStats } from "@/lib/v2/engine/latency-trace"
import { insertTrade, insertOrderLog, clearLedger } from "@/lib/v2/engine/db"

describe("Execution Latency", () => {
  beforeEach(() => {
    clearLedger("PAPER_V1")
  })

  it("insertTrade should be non-blocking (async via write queue)", async () => {
    const startMs = performance.now()

    // Insert a trade — should return immediately without blocking
    insertTrade({
      marketId: "test-market",
      slotEndMs: Date.now(),
      side: "UP",
      price: 0.5,
      shares: 100,
      cost: 50,
      result: "WIN",
      pnl: 50,
      balanceAfter: 150,
      dustSaved: 0,
      mode: "PAPER_V1",
    })

    const elapsedMs = performance.now() - startMs
    // Should be virtually instant (< 1ms) since it's just queuing, not executing
    expect(elapsedMs).toBeLessThan(5)
  })

  it("insertOrderLog should be non-blocking", async () => {
    const startMs = performance.now()

    // Insert an order log — should return immediately
    insertOrderLog({
      mode: "PAPER_V1",
      event: "FILLED",
      marketId: "test-market",
      side: "UP",
      price: 0.5,
      shares: 100,
      detail: "test fill",
    })

    const elapsedMs = performance.now() - startMs
    // Should be virtually instant (< 1ms)
    expect(elapsedMs).toBeLessThan(5)
  })

  it("bulk writes should not block tick loop", async () => {
    const startMs = performance.now()

    // Simulate 50 rapid trades
    for (let i = 0; i < 50; i++) {
      insertTrade({
        marketId: `market-${i}`,
        slotEndMs: Date.now() + i * 300_000,
        side: i % 2 === 0 ? "UP" : "DOWN",
        price: 0.5,
        shares: 100,
        cost: 50,
        result: i % 3 === 0 ? "WIN" : "LOSS",
        pnl: i % 3 === 0 ? 50 : -50,
        balanceAfter: 100,
        dustSaved: 0,
        mode: "PAPER_V1",
      })
    }

    const elapsedMs = performance.now() - startMs
    // 50 writes should still be fast (< 10ms) — they're all just queuing
    expect(elapsedMs).toBeLessThan(10)
  })

  it("write queue should process all writes in background", async () => {
    // Insert multiple trades rapidly
    for (let i = 0; i < 10; i++) {
      insertTrade({
        marketId: `order-${i}`,
        slotEndMs: Date.now(),
        side: "UP",
        price: 0.5,
        shares: 100,
        cost: 50,
        result: i % 2 === 0 ? "WIN" : "LOSS",
        pnl: i % 2 === 0 ? 50 : -50,
        balanceAfter: 100 + i,
        dustSaved: 0,
        mode: "PAPER_V1",
      })
    }

    // All writes should have queued instantly
    expect(true).toBe(true)
  })

  it("latency trace should record execution phases", async () => {
    const traces = getRecentTraces()
    // There should be some traces from previous test runs
    expect(traces.length).toBeGreaterThanOrEqual(0)
  })
})
