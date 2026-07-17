// ============================================================================
// RECONCILER TESTS — exchange-truth vs local-state drift detection
// ============================================================================
// The reconciler is the last line of defense against the most dangerous live
// failure mode: an order resting on the account that the engine is not
// tracking. These tests drive runOnce() directly with a mocked executor.
// ============================================================================

import { describe, expect, it } from "vitest"
import { Reconciler } from "@/lib/v2/engine/reconciler"
import type { Executor } from "@/lib/v2/engine/execution/executor"
import type { OpenOrder } from "@/lib/v2/engine/types"

function makeOrder(exchangeOrderId: string): OpenOrder {
  return {
    id: `local-${exchangeOrderId}`,
    exchangeOrderId,
    side: "UP",
    price: 0.5,
    shares: 10,
    filledShares: 0,
    status: "OPEN",
    placedAtMs: Date.now(),
    tokenId: "tok",
    marketId: "mkt",
  } as unknown as OpenOrder
}

interface MockOpts {
  exchangeOrderIds?: string[]
  tracked?: OpenOrder[]
  walletUsd?: number | null
  localBalance?: number
  live?: boolean
  running?: boolean
  failWith?: string
}

function makeReconciler(opts: MockOpts = {}) {
  const executor = {
    getOpenOrdersLive: async () => {
      if (opts.failWith) throw new Error(opts.failWith)
      return (opts.exchangeOrderIds ?? []).map((id) => ({ id }))
    },
    getAvailableBalanceUsd:
      opts.walletUsd === null
        ? undefined
        : async () => {
            return opts.walletUsd ?? 0
          },
  } as unknown as Executor
  return new Reconciler({
    getExecutor: () => executor,
    getTrackedOrders: () => opts.tracked ?? [],
    getLocalBalanceUsd: () => opts.localBalance ?? 0,
    isLive: () => opts.live ?? true,
    isRunning: () => opts.running ?? true,
  })
}

describe("Reconciler", () => {
  it("reports ok when exchange and local views match exactly", async () => {
    const r = makeReconciler({
      exchangeOrderIds: ["a", "b"],
      tracked: [makeOrder("a"), makeOrder("b")],
      walletUsd: 100,
      localBalance: 100,
    })
    const report = await r.runOnce("test")
    expect(report).not.toBeNull()
    expect(report!.ok).toBe(true)
    expect(report!.untrackedOrderIds).toEqual([])
    expect(report!.missingOrderIds).toEqual([])
    expect(report!.walletDriftUsd).toBe(0)
  })

  it("flags an UNTRACKED live order — the most dangerous drift state", async () => {
    const r = makeReconciler({
      exchangeOrderIds: ["rogue-order"],
      tracked: [],
    })
    const report = await r.runOnce("test")
    expect(report!.ok).toBe(false)
    expect(report!.untrackedOrderIds).toEqual(["rogue-order"])
  })

  it("flags a MISSING tracked order (externally cancelled/filled unseen)", async () => {
    const r = makeReconciler({
      exchangeOrderIds: [],
      tracked: [makeOrder("vanished")],
    })
    const report = await r.runOnce("test")
    expect(report!.ok).toBe(false)
    expect(report!.missingOrderIds).toEqual(["vanished"])
  })

  it("computes wallet drift", async () => {
    const r = makeReconciler({ walletUsd: 105.5, localBalance: 100 })
    const report = await r.runOnce("test")
    expect(report!.walletDriftUsd).toBe(5.5)
  })

  it("skips entirely when not live", async () => {
    const r = makeReconciler({ live: false, exchangeOrderIds: ["x"] })
    const report = await r.runOnce("test")
    expect(report).toBeNull() // never ran → no report
  })

  it("skips entirely when engine is not running", async () => {
    const r = makeReconciler({ running: false, exchangeOrderIds: ["x"] })
    const report = await r.runOnce("test")
    expect(report).toBeNull()
  })

  it("survives an exchange API failure and reports the error", async () => {
    const r = makeReconciler({ failWith: "HTTP 503 exchange down" })
    const report = await r.runOnce("test")
    expect(report!.ok).toBe(false)
    expect(report!.error).toContain("HTTP 503")
    // Must recover on the next cycle when the API is back.
    const r2 = makeReconciler({ exchangeOrderIds: [] })
    const report2 = await r2.runOnce("test")
    expect(report2!.ok).toBe(true)
  })

  it("ignores tracked orders that have no exchangeOrderId yet (in-flight placement)", async () => {
    const inFlight = makeOrder("")
    const r = makeReconciler({ exchangeOrderIds: [], tracked: [inFlight] })
    const report = await r.runOnce("test")
    // An order with no exchange id can't be "missing" — it was never confirmed.
    expect(report!.ok).toBe(true)
    expect(report!.trackedOrders).toBe(0)
  })
})
