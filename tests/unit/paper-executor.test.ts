import { beforeEach, describe, expect, it } from "vitest"
import { PaperExecutor } from "@/lib/v2/engine/execution/paper"
import type { PlaceOrderRequest } from "@/lib/v2/engine/execution/executor"
import type { TradeSide } from "@/lib/v2/engine/types"

// ------------------------------------------------------------
// PaperExecutor lifecycle tests. Chaos is zeroed so every test
// is deterministic; dedicated tests then turn each chaos knob on.
// ------------------------------------------------------------

const NO_CHAOS = {
  latencyMinMs: 0,
  latencyMaxMs: 1,
  rejectRate: 0,
  timeoutRate: 0,
  partialFillRate: 0,
  slowAckRate: 0,
  outageUntilMs: 0,
}

/** Controllable live-ask source standing in for the CLOB feed. */
function askSource(initial: number | null) {
  let ask = initial
  return {
    fn: (_side: TradeSide) => ask,
    set(v: number | null) {
      ask = v
    },
  }
}

function req(over: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest {
  return {
    marketId: "paper-test-market",
    tokenId: "token-up",
    side: "UP",
    price: 0.5,
    shares: 10,
    phase: "PRIORITY_1",
    tif: "GTC",
    expireAtMs: null,
    ...over,
  }
}

describe("PaperExecutor — order lifecycle (deterministic)", () => {
  let asks: ReturnType<typeof askSource>
  let ex: PaperExecutor

  beforeEach(() => {
    asks = askSource(0.6) // live ask ABOVE limit — no fill yet
    ex = new PaperExecutor(asks.fn, { startingWalletUsd: 100, chaos: NO_CHAOS })
  })

  it("places a maker order and reports it LIVE while the ask is above the limit", async () => {
    const order = await ex.placeOrder(req())
    expect(order.exchangeOrderId).toMatch(/^sim-/)
    expect(await ex.getOrderState(order)).toBe("LIVE")
    expect(await ex.checkFill(order)).toBeNull()
  })

  it("fills exactly when the LIVE ask crosses at/below the limit price", async () => {
    const order = await ex.placeOrder(req({ price: 0.5, shares: 10 }))
    expect(await ex.checkFill(order)).toBeNull() // ask 0.60 > 0.50
    asks.set(0.5) // live market reaches our limit
    const fill = await ex.checkFill(order)
    expect(fill).not.toBeNull()
    expect(fill!.order.shares).toBe(10)
    expect(fill!.filledPrice).toBe(0.5)
    expect(await ex.getOrderState(order)).toBe("MATCHED")
  })

  it("debits the simulated wallet on fill (at min(limit, live ask) per Bug #013)", async () => {
    const before = await ex.getAvailableBalanceUsd()
    const order = await ex.placeOrder(req({ price: 0.4, shares: 10 }))
    asks.set(0.35)
    await ex.checkFill(order)
    const after = await ex.getAvailableBalanceUsd()
    // Bug #013: marketable BUY fills at the resting ask ($0.35), not at the
    // taker's $0.40 limit. Debit is therefore 10 × $0.35 = $3.50, not $4.00.
    expect(before! - after!).toBeCloseTo(3.5, 2)
  })

  it("never fills while the live feed is stale (null ask)", async () => {
    const order = await ex.placeOrder(req({ price: 0.99, shares: 5 }))
    asks.set(null) // data blackout — a real book can't be observed either
    expect(await ex.checkFill(order)).toBeNull()
    expect(await ex.getOrderState(order)).toBe("LIVE")
  })

  it("cancel makes the order DEAD and prevents any later fill", async () => {
    const order = await ex.placeOrder(req())
    await ex.cancelOrder(order)
    expect(await ex.getOrderState(order)).toBe("DEAD")
    asks.set(0.01) // even a deep cross must not fill a cancelled order
    expect(await ex.checkFill(order)).toBeNull()
  })

  it("cancelReplace swaps price atomically and the new order fills at its own limit", async () => {
    const order = await ex.placeOrder(req({ price: 0.4 }))
    const { order: next } = await ex.cancelReplace(order, req({ price: 0.55 }))
    expect(next.price).toBe(0.55)
    expect(await ex.getOrderState(order)).toBe("DEAD")
    asks.set(0.55)
    const fill = await ex.checkFill(next)
    expect(fill).not.toBeNull()
  })

  it("expires GTD orders after expireAtMs (TIF handling)", async () => {
    const order = await ex.placeOrder(req({ expireAtMs: Date.now() - 1 }))
    expect(await ex.getOrderState(order)).toBe("DEAD")
    asks.set(0.1)
    expect(await ex.checkFill(order)).toBeNull()
  })

  it("rejects orders the real CLOB would reject (size, price bounds, balance)", async () => {
    await expect(ex.placeOrder(req({ shares: 0 }))).rejects.toThrow(/size below minimum/)
    await expect(ex.placeOrder(req({ price: 0 }))).rejects.toThrow(/price out of/)
    await expect(ex.placeOrder(req({ price: 0.99, shares: 500 }))).rejects.toThrow(/not enough balance/)
  })

  it("cancelAllOrders purges every resting order (kill-switch path)", async () => {
    const a = await ex.placeOrder(req())
    const b = await ex.placeOrder(req({ side: "DOWN", tokenId: "token-down" }))
    await ex.cancelAllOrders()
    expect(await ex.getOrderState(a)).toBe("DEAD")
    expect(await ex.getOrderState(b)).toBe("DEAD")
    expect(await ex.getOpenOrdersLive()).toHaveLength(0)
  })

  it("mirrors fills into the account trades feed (dashboard LiveAccount path)", async () => {
    const order = await ex.placeOrder(req({ price: 0.5, shares: 4 }))
    asks.set(0.45)
    await ex.checkFill(order)
    const trades = await ex.getRecentTradesLive()
    expect(trades.length).toBe(1)
    expect(trades[0].size).toBe(4)
    expect(trades[0].outcome).toBe("UP")
  })

  it("creditSettlement adds the payout back to the simulated wallet", async () => {
    const order = await ex.placeOrder(req({ price: 0.5, shares: 10 }))
    asks.set(0.5)
    await ex.checkFill(order)
    const afterFill = await ex.getAvailableBalanceUsd()
    ex.creditSettlement(10) // WIN pays $1/share
    const afterSettle = await ex.getAvailableBalanceUsd()
    expect(afterSettle! - afterFill!).toBeCloseTo(10, 2)
  })
})

describe("PaperExecutor — chaos injection", () => {
  it("partial fills report the partial and cancel the remainder (live semantics)", async () => {
    const asks = askSource(0.6)
    const ex = new PaperExecutor(asks.fn, {
      startingWalletUsd: 100,
      chaos: { ...NO_CHAOS, partialFillRate: 1 },
    })
    const order = await ex.placeOrder(req({ price: 0.5, shares: 10 }))
    asks.set(0.5)
    const fill = await ex.checkFill(order)
    expect(fill).not.toBeNull()
    expect(fill!.order.shares).toBeGreaterThanOrEqual(1)
    expect(fill!.order.shares).toBeLessThan(10)
    // Remainder must be cancelled — the order can never fill again.
    expect(await ex.getOrderState(order)).toBe("DEAD")
    asks.set(0.1)
    expect(await ex.checkFill(order)).toBeNull()
  })

  it("simulated rejections throw the same error shape the engine already handles", async () => {
    const asks = askSource(0.6)
    const ex = new PaperExecutor(asks.fn, {
      startingWalletUsd: 100,
      chaos: { ...NO_CHAOS, rejectRate: 1 },
    })
    await expect(ex.placeOrder(req())).rejects.toThrow(/CLOB rejected order/)
  })

  it("outage makes every API call fail until it lifts, then recovers", async () => {
    const asks = askSource(0.6)
    const ex = new PaperExecutor(asks.fn, { startingWalletUsd: 100, chaos: NO_CHAOS })
    ex.simulateOutage(150)
    await expect(ex.placeOrder(req())).rejects.toThrow(/outage/)
    expect(await ex.getAvailableBalanceUsd()).toBeNull() // soft-fail like live
    await new Promise((r) => setTimeout(r, 200))
    const order = await ex.placeOrder(req())
    expect(order.exchangeOrderId).toBeTruthy()
  })

  it("cancelReplace refuses to duplicate when cancel fails and the old order is still LIVE", async () => {
    const asks = askSource(0.6)
    const ex = new PaperExecutor(asks.fn, { startingWalletUsd: 100, chaos: NO_CHAOS })
    const order = await ex.placeOrder(req())
    // Force the next cancel call to fail via a one-shot outage window, while
    // getOrderState (after outage lifts) still reports LIVE.
    const origCancel = ex.cancelOrder.bind(ex)
    ex.cancelOrder = async () => {
      throw new Error("[SIM] simulated API timeout (cancelOrder)")
    }
    await expect(ex.cancelReplace(order, req({ price: 0.55 }))).rejects.toThrow(/refusing to post a duplicate/)
    ex.cancelOrder = origCancel
    // The original order must still be intact — no duplicate was posted.
    expect(await ex.getOrderState(order)).toBe("LIVE")
    expect(await ex.getOpenOrdersLive()).toHaveLength(1)
  })
})
