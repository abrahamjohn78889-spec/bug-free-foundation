/**
 * INC-004 PR-002 regression tests.
 *
 *  C1 — Reconciler.runOnce() drains the AMBIGUOUS intent queue when
 *       intent-first recovery is enabled and a lookup is wired in.
 *
 *  H1 — After N consecutive cycles observe the SAME untracked exchange
 *       order id, the reconciler auto-cancels it.
 *
 *  H3 — LiveExecutor.checkFill escalates via the anomaly handler when BOTH
 *       the partial-remainder cancel AND the authoritative re-read fail.
 *
 *  C5 — db.getWriteQueueHealth() reports errors surfaced by processWriteQueue
 *       instead of swallowing them silently.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Executor } from "@/lib/v2/engine/execution/executor"
import type { OpenOrder } from "@/lib/v2/engine/types"

type DbModule = typeof import("@/lib/v2/engine/db")
let db: DbModule
let Reconciler: typeof import("@/lib/v2/engine/reconciler").Reconciler

async function freshDb(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inc004-pr002-"))
  process.env.DB_PATH = path.join(tmp, "ledger.db")
  vi.resetModules()
  db = await import("@/lib/v2/engine/db")
  Reconciler = (await import("@/lib/v2/engine/reconciler")).Reconciler
}

beforeEach(async () => {
  await freshDb()
})

function fakeExecutor(exchangeOrderIds: string[]): Executor {
  return {
    getOpenOrdersLive: async () => exchangeOrderIds.map((id) => ({ id })),
  } as unknown as Executor
}

describe("PR-002 C1 — Stage 5 recovery wired into Reconciler.runOnce", () => {
  it("drains AMBIGUOUS intents when recovery flag is enabled", async () => {
    // Seed an AMBIGUOUS intent.
    const intentId = db.createPendingIntent({
      clientOrderId: "coid-pr002-c1",
      mode: "LIVE_V2",
      marketId: "m1",
      tokenId: "tok",
      side: "BUY",
      price: 0.5,
      shares: 10,
      nowMs: 1_000,
    })
    db.markIntentSubmitted(intentId, 1_001)
    db.markIntentAmbiguous(intentId, "LOST_ACK", 1_002)

    const r = new Reconciler({
      getExecutor: () => fakeExecutor([]),
      getTrackedOrders: () => [],
      getLocalBalanceUsd: () => 0,
      isLive: () => true,
      isRunning: () => true,
      isIntentRecoveryEnabled: () => true,
      getIntentLookup: () => ({ findOrdersByClientOrderId: async () => [] }),
    })
    await r.runOnce("test-c1")

    const after = db.getIntentById(intentId)
    expect(after?.status).toBe("FAILED")
    expect(after?.last_error).toBe("reconciled_absent")
  })

  it("stays dormant when recovery flag is OFF (legacy behaviour)", async () => {
    const intentId = db.createPendingIntent({
      clientOrderId: "coid-pr002-c1-off",
      mode: "LIVE_V2",
      marketId: "m1",
      tokenId: "tok",
      side: "BUY",
      price: 0.5,
      shares: 10,
      nowMs: 1_000,
    })
    db.markIntentSubmitted(intentId, 1_001)
    db.markIntentAmbiguous(intentId, "LOST_ACK", 1_002)

    const r = new Reconciler({
      getExecutor: () => fakeExecutor([]),
      getTrackedOrders: () => [],
      getLocalBalanceUsd: () => 0,
      isLive: () => true,
      isRunning: () => true,
      isIntentRecoveryEnabled: () => false,
      getIntentLookup: () => ({ findOrdersByClientOrderId: async () => [] }),
    })
    await r.runOnce("test-c1-off")
    expect(db.getIntentById(intentId)?.status).toBe("AMBIGUOUS")
  })
})

describe("PR-002 H1 — untracked-order auto-remediation", () => {
  function makeTracked(exchangeOrderId: string): OpenOrder {
    return { exchangeOrderId } as unknown as OpenOrder
  }

  it("auto-cancels an untracked order after the streak crosses the threshold", async () => {
    const untrackedId = "exch-untracked-A"
    const cancels: string[] = []
    const r = new Reconciler({
      getExecutor: () => fakeExecutor([untrackedId]),
      getTrackedOrders: () => [],
      getLocalBalanceUsd: () => 0,
      isLive: () => true,
      isRunning: () => true,
      getUntrackedRemediationThreshold: () => 3,
      cancelExchangeOrder: async (id: string) => {
        cancels.push(id)
      },
    })
    await r.runOnce("cyc1")
    expect(cancels).toEqual([])
    await r.runOnce("cyc2")
    expect(cancels).toEqual([])
    await r.runOnce("cyc3")
    expect(cancels).toEqual([untrackedId])
  })

  it("clears the streak when the untracked id disappears (drift resolved)", async () => {
    const cancels: string[] = []
    let currentUntracked = ["exch-fickle"]
    const r = new Reconciler({
      getExecutor: () => ({
        getOpenOrdersLive: async () => currentUntracked.map((id) => ({ id })),
      } as unknown as Executor),
      getTrackedOrders: () => [],
      getLocalBalanceUsd: () => 0,
      isLive: () => true,
      isRunning: () => true,
      getUntrackedRemediationThreshold: () => 3,
      cancelExchangeOrder: async (id: string) => cancels.push(id) && undefined,
    })
    await r.runOnce("a")
    await r.runOnce("b")
    currentUntracked = [] // drift resolved
    await r.runOnce("c")
    // Reintroduced later — streak must have been cleared.
    currentUntracked = ["exch-fickle"]
    await r.runOnce("d")
    await r.runOnce("e")
    expect(cancels).toEqual([])
  })

  it("threshold ≤ 0 disables auto-cancellation (kill-switch mode)", async () => {
    const cancels: string[] = []
    const r = new Reconciler({
      getExecutor: () => fakeExecutor(["exch-x"]),
      getTrackedOrders: () => [],
      getLocalBalanceUsd: () => 0,
      isLive: () => true,
      isRunning: () => true,
      getUntrackedRemediationThreshold: () => 0,
      cancelExchangeOrder: async (id: string) => cancels.push(id) && undefined,
    })
    for (let i = 0; i < 10; i++) await r.runOnce(`k${i}`)
    expect(cancels).toEqual([])
  })
})

describe("PR-002 C5 — write-queue health surfaces errors", () => {
  it("reports the last error and error count when an op throws", async () => {
    db.resetWriteQueueHealthForTests()
    // insertLatencySample enqueues a bare INSERT without an inner try/catch,
    // so a schema violation surfaces cleanly through the queue's error path.
    // Drop the latency_samples table to guarantee the enqueued statement fails.
    const dbHandle = db.getDbHandle()
    dbHandle.exec("DROP TABLE IF EXISTS latency_samples")

    db.insertLatencySample({
      mode: "PAPER_V1",
      marketId: "m", exchangeOrderId: "ex-1", side: "UP", shares: 1,
      limitPrice: 0.5, quoteAgeMs: 0, decisionMs: 0, preSubmitMs: 0,
      submitMs: 0, fillCheckMs: 0, totalMs: 0, submitAtMs: Date.now(),
    })
    db.flushWriteQueueSync()

    const h = db.getWriteQueueHealth()
    expect(h.errors).toBeGreaterThanOrEqual(1)
    expect(h.lastError).toBeTruthy()
  })
})

describe("PR-002 H3 — partial-fill anomaly escalation", () => {
  it("fires the anomaly callback when both cancel and re-read fail", async () => {
    const { LiveExecutor } = await import("@/lib/v2/engine/execution/live")
    // Bypass the constructor: it requires real POLY_* env. Build via prototype.
    const ex = Object.create(LiveExecutor.prototype) as InstanceType<typeof LiveExecutor>
    let getOrderCalls = 0
    ;(ex as unknown as { client: unknown }).client = {
      getOrder: async () => {
        getOrderCalls += 1
        if (getOrderCalls === 1) {
          return { status: "LIVE", size_matched: "3", price: "0.50" }
        }
        throw new Error("reread-503")
      },
      cancelOrder: async () => {
        throw new Error("cancel-503")
      },
    }
    const notes: string[] = []
    ex.setFillCheckAnomalyHandler((d: string) => notes.push(d))
    const order = {
      exchangeOrderId: "ex-1",
      shares: 10,
      price: 0.5,
    } as unknown as OpenOrder
    await ex.checkFill(order)
    expect(notes.length).toBe(1)
    expect(notes[0]).toContain("cancel=cancel-503")
    expect(notes[0]).toContain("reread=reread-503")
  })
})
