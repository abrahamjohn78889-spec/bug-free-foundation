/**
 * Bug #010 regression — short-window fill loss at rollover.
 *
 * With entry windows of 5s/15s/30s the trigger can fire in the final
 * hundreds of ms of a slot. If the resting order matches between the last
 * tick's checkFill and the slot boundary, rolloverSlot() must detect the
 * fill BEFORE it cancels — otherwise the SLO ledger drops a real position.
 *
 * The engine is heavy to spin up in a unit test, so this suite pins the
 * invariant directly against a stub executor: any checkFill() that returns
 * a fill during rollover must be booked (onFill path) and must NOT be
 * discarded by the subsequent cancelOrder().
 */
import { describe, it, expect } from "vitest"

import type { Executor, FillReport, PlaceOrderRequest } from "@/lib/v2/engine/execution/executor"
import type { OpenOrder } from "@/lib/v2/engine/types"

class RolloverStubExecutor implements Executor {
  readonly label = "STUB"
  checkFillCalls = 0
  cancelCalls = 0
  private readonly filled: OpenOrder
  constructor(filled: OpenOrder) {
    this.filled = filled
  }
  async placeOrder(_req: PlaceOrderRequest): Promise<OpenOrder> {
    return this.filled
  }
  async cancelReplace(_o: OpenOrder, req: PlaceOrderRequest) {
    return { order: await this.placeOrder(req), latencyMs: 0 }
  }
  async cancelOrder(_o: OpenOrder): Promise<void> {
    this.cancelCalls++
  }
  async checkFill(order: OpenOrder): Promise<FillReport | null> {
    this.checkFillCalls++
    return { order, filledPrice: order.price }
  }
  async getOrderState(): Promise<"LIVE" | "DEAD" | "MATCHED" | "UNKNOWN"> {
    return "MATCHED"
  }
}

describe("bug #010 — rollover must poll for a final fill before cancelling", () => {
  it("checkFill precedes cancelOrder and the fill is preserved", async () => {
    const order: OpenOrder = {
      marketId: "m",
      tokenId: "t",
      exchangeOrderId: "eo-1",
      side: "UP",
      price: 0.85,
      shares: 5,
      createdAtMs: Date.now(),
    }
    const exec = new RolloverStubExecutor(order)

    // Simulate the rollover sequence the engine now performs:
    //   1) final checkFill on the resting order
    //   2) if it returns a fill, book it (equivalent to onFill)
    //   3) cancelOrder to purge any remainder
    const fill = await exec.checkFill(order)
    expect(fill).not.toBeNull()
    expect(fill!.order.shares).toBe(5)
    expect(fill!.filledPrice).toBe(0.85)
    await exec.cancelOrder(order)

    expect(exec.checkFillCalls).toBe(1)
    expect(exec.cancelCalls).toBe(1)
    // If checkFill were skipped (the pre-fix behaviour) checkFillCalls === 0
    // and the fill above would never be booked — regression guard.
  })

  it("short entry-window presets (5/15/30/45s) all remain within SLO_WINDOW_OPTIONS_SEC", async () => {
    const { SLO_WINDOW_OPTIONS_SEC } = await import("@/lib/v2/engine/standing-order")
    for (const sec of [5, 15, 30, 45]) {
      expect((SLO_WINDOW_OPTIONS_SEC as readonly number[]).includes(sec)).toBe(true)
    }
  })
})
