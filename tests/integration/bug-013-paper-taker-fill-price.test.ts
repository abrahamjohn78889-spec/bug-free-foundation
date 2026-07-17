/**
 * Bug #013 — Paper executor fills at min(limit, live ask).
 *
 * A marketable LIMIT BUY (limit > best ask) on real Polymarket fills at
 * the resting ask; the paper simulator was booking at the limit,
 * systematically over-paying (limit - ask) per share.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { PaperExecutor, ZERO_CHAOS } from "@/lib/v2/engine/execution/paper"
import type { PlaceOrderRequest } from "@/lib/v2/engine/execution/executor"
import type { TradeSide } from "@/lib/v2/engine/types"

function askSource(initial: number | null) {
  let ask = initial
  return {
    fn: (_side: TradeSide) => ask,
    set(v: number | null) {
      ask = v
    },
  }
}

const baseReq = (over: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => ({
  marketId: "m",
  tokenId: "t",
  side: "UP",
  price: 0.99,
  shares: 5,
  phase: "PRIORITY_1",
  tif: "GTC",
  expireAtMs: null,
  ...over,
})

describe("Bug #013 — paper fills at min(limit, live ask)", () => {
  let asks: ReturnType<typeof askSource>
  let exec: PaperExecutor

  beforeEach(() => {
    asks = askSource(0.85)
    exec = new PaperExecutor(asks.fn, { startingWalletUsd: 100, chaos: ZERO_CHAOS })
  })

  it("marketable BUY fills at live ask, not at limit", async () => {
    const placed = await exec.placeOrder(baseReq({ price: 0.99, shares: 5 }))
    const fill = await exec.checkFill(placed)
    expect(fill).not.toBeNull()
    expect(fill!.filledPrice).toBeCloseTo(0.85, 6)
    expect(fill!.order.shares).toBe(5)
  })

  it("non-marketable maker fill uses the limit price when ask later crosses at limit", async () => {
    asks.set(0.99)
    const placed = await exec.placeOrder(baseReq({ price: 0.99, shares: 3 }))
    const fill = await exec.checkFill(placed)
    expect(fill).not.toBeNull()
    expect(fill!.filledPrice).toBeCloseTo(0.99, 6)
  })
})
