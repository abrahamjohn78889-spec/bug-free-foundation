import { describe, expect, it, vi } from "vitest"
import { LiveExecutor } from "../../lib/v2/engine/execution/live"
import type { PlaceOrderRequest } from "../../lib/v2/engine/execution/executor"

/**
 * BUG #009 — REGRESSION
 *
 * The standing-order trigger fires the moment the ask reaches `triggerPrice`,
 * and submits a LIMIT BUY at `limitPrice` where `limitPrice >= triggerPrice`
 * (validated in `armStandingOrder`). That order is DELIBERATELY marketable —
 * a real Polymarket CLOB post-only order in that state is rejected with
 * "would cross the spread" and the trigger never fills.
 *
 * The scenario that surfaced this bug: trigger 70¢, limit 85¢. Trigger fires
 * at ask ≥ 0.70, order submitted at 0.85. When ask ∈ [0.70, 0.85], the 0.85
 * BUY crosses → post-only rejects → every triggered order failed.
 *
 * Fix: `PlaceOrderRequest.postOnly` controls the flag per call. Standing-order
 * passes `false`. The classic quote loop (engine.ts:1097) keeps the default
 * (post-only true) because its whole point IS resting maker rebates.
 */

function makeExecutor(recorder: { postOnly?: boolean } = {}) {
  // Bypass constructor (avoids wallet + CLOB creds).
  const exec = Object.create(LiveExecutor.prototype) as LiveExecutor & {
    client: {
      createAndPostOrder: (
        order: unknown,
        opts: unknown,
        orderType: unknown,
        postOnly: boolean,
      ) => Promise<{ success: boolean; orderID: string }>
    }
  }
  exec.client = {
    createAndPostOrder: vi.fn(async (_o, _opts, _type, postOnly: boolean) => {
      recorder.postOnly = postOnly
      return { success: true, orderID: "0xdead" }
    }),
  }
  return exec
}

const baseReq: PlaceOrderRequest = {
  marketId: "market-x",
  tokenId: "token-up",
  side: "UP",
  price: 0.85,
  shares: 7,
  phase: "WAITING",
  tif: "GTC",
  expireAtMs: null,
}

describe("BUG #009 — postOnly per-request flag on LiveExecutor.placeOrder", () => {
  it("defaults to post-only=true when postOnly is not set (safe default, classic quote loop)", async () => {
    const rec: { postOnly?: boolean } = {}
    const exec = makeExecutor(rec)
    await exec.placeOrder(baseReq)
    expect(rec.postOnly).toBe(true)
  })

  it("respects postOnly=true when explicitly set", async () => {
    const rec: { postOnly?: boolean } = {}
    const exec = makeExecutor(rec)
    await exec.placeOrder({ ...baseReq, postOnly: true })
    expect(rec.postOnly).toBe(true)
  })

  it("standing-order trigger fire (postOnly=false) forwards to the CLOB as a taker-allowed order", async () => {
    // Regression: without this pass-through, trigger 70¢/limit 85¢ orders
    // were rejected by CLOB (would-cross) on LIVE_V2.
    const rec: { postOnly?: boolean } = {}
    const exec = makeExecutor(rec)
    await exec.placeOrder({ ...baseReq, postOnly: false })
    expect(rec.postOnly).toBe(false)
  })

  it("marketable trigger order (limit 0.85, ask 0.72) posts as taker-allowed — otherwise CLOB rejects would-cross", async () => {
    // Simulate the standing-order scenario end-to-end at the executor edge.
    const rec: { postOnly?: boolean } = {}
    const exec = makeExecutor(rec)
    const askAtSubmit = 0.72 // trigger 0.70 hit, ask now 0.72, limit 0.85
    const isMarketable = baseReq.price >= askAtSubmit
    expect(isMarketable).toBe(true) // sanity: this IS the marketable case
    await exec.placeOrder({ ...baseReq, postOnly: false })
    expect(rec.postOnly).toBe(false)
  })
})
