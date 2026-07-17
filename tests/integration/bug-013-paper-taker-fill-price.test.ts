/**
 * Bug #013 — Paper executor filled at limit instead of live ask.
 * A marketable LIMIT BUY (limit > best ask) on real Polymarket fills at
 * the resting ask; the paper simulator was booking at the limit,
 * systematically over-paying (limit - ask) per share.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import { PaperExecutor } from "../../lib/v2/engine/execution/paper"

describe("Bug #013 — paper fills at min(limit, live ask)", () => {
  let exec: PaperExecutor
  beforeEach(() => {
    exec = new PaperExecutor({ rejectRate: 0, timeoutRate: 0, partialFillRate: 0, networkJitterMs: 0 })
    exec.setWalletUsd?.(100)
    vi.spyOn(Math, "random").mockReturnValue(0.99) // never reject/timeout
  })

  it("marketable BUY fills at live ask, not at limit", async () => {
    exec.updatePriceForSide?.("UP", 0.85)
    const placed = await exec.placeOrder({
      marketId: "m", tokenId: "t", side: "UP", price: 0.99, shares: 5,
      phase: "WAITING" as any, expireAtMs: null,
    } as any)
    const fill = await exec.checkFill(placed)
    expect(fill).not.toBeNull()
    expect(fill!.filledPrice).toBeCloseTo(0.85, 6)
    expect(fill!.order.shares).toBe(5)
  })

  it("non-marketable maker fill uses the limit price when ask later crosses at limit", async () => {
    exec.updatePriceForSide?.("UP", 0.99)
    const placed = await exec.placeOrder({
      marketId: "m", tokenId: "t", side: "UP", price: 0.99, shares: 3,
      phase: "WAITING" as any, expireAtMs: null,
    } as any)
    const fill = await exec.checkFill(placed)
    expect(fill).not.toBeNull()
    expect(fill!.filledPrice).toBeCloseTo(0.99, 6)
  })
})
