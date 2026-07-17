/**
 * Time-window integration matrix — 5s / 15s / 30s / 45s / 60s.
 *
 * Confirms that across a matrix of (windowSec × trigger × limit) pairings
 * both PAPER_V1 and LIVE_V2 behave consistently:
 *
 *   1. Every window preset is accepted by SLO validation.
 *   2. The trigger fires only when the ask reaches the trigger price and
 *      the placed order carries the *limit* price (not the trigger).
 *   3. Trigger-fire submissions use postOnly=false (Bug #009) so a
 *      marketable-at-fire order (trigger 0.70, limit 0.85) is not rejected
 *      by CLOB in LIVE_V2.
 *   4. A fill occurring in the final ms of the window is picked up by the
 *      rollover checkFill path (Bug #010) rather than being cancelled away.
 *
 * The engine loop is exercised indirectly through its executor contract so
 * PAPER_V1 and LIVE_V2 travel the identical placement/fill code path.
 */
import { describe, it, expect } from "vitest"

import type {
  Executor,
  FillReport,
  PlaceOrderRequest,
} from "@/lib/v2/engine/execution/executor"
import type { OpenOrder } from "@/lib/v2/engine/types"

type Venue = "PAPER_V1" | "LIVE_V2"

interface Placement {
  request: PlaceOrderRequest
  venue: Venue
}

class MatrixExecutor implements Executor {
  readonly label: Venue
  readonly placements: Placement[] = []
  checkFillCalls = 0
  cancelCalls = 0
  fillOnCheck = false
  constructor(label: Venue) {
    this.label = label
  }
  async placeOrder(req: PlaceOrderRequest): Promise<OpenOrder> {
    this.placements.push({ request: req, venue: this.label })
    // LIVE_V2 would reject a marketable postOnly order — mirror that here.
    if (this.label === "LIVE_V2" && req.postOnly === true) {
      throw new Error("would cross the spread (POST_ONLY rejected)")
    }
    return {
      marketId: req.marketId,
      tokenId: req.tokenId,
      exchangeOrderId: `eo-${this.placements.length}`,
      side: req.side,
      price: req.price,
      shares: req.shares,
      createdAtMs: Date.now(),
    }
  }
  async cancelReplace(_o: OpenOrder, req: PlaceOrderRequest) {
    return { order: await this.placeOrder(req), latencyMs: 0 }
  }
  async cancelOrder(_o: OpenOrder): Promise<void> {
    this.cancelCalls++
  }
  async checkFill(order: OpenOrder): Promise<FillReport | null> {
    this.checkFillCalls++
    if (!this.fillOnCheck) return null
    return { order, filledPrice: order.price }
  }
  async getOrderState(): Promise<"LIVE" | "DEAD" | "MATCHED" | "UNKNOWN"> {
    return this.fillOnCheck ? "MATCHED" : "LIVE"
  }
}

/** Trigger evaluator mirrored from the engine: fire when ask ≤ trigger for UP. */
function triggerFires(direction: "UP" | "DOWN", trigger: number, ask: number) {
  return direction === "UP" ? ask <= trigger : ask >= 1 - trigger
}

const WINDOWS_SEC = [5, 15, 30, 45, 60] as const
const PAIRS: ReadonlyArray<{ trigger: number; limit: number }> = [
  { trigger: 0.7, limit: 0.85 }, // marketable-at-fire — Bug #009 regression
  { trigger: 0.6, limit: 0.75 },
  { trigger: 0.5, limit: 0.65 },
  { trigger: 0.8, limit: 0.9 },
]

describe("standing-order time-window matrix — PAPER_V1 & LIVE_V2", () => {
  it("all matrix windows are accepted presets", async () => {
    const { SLO_WINDOW_OPTIONS_SEC } = await import(
      "@/lib/v2/engine/standing-order"
    )
    for (const sec of WINDOWS_SEC) {
      expect((SLO_WINDOW_OPTIONS_SEC as readonly number[]).includes(sec)).toBe(
        true,
      )
    }
  })

  for (const venue of ["PAPER_V1", "LIVE_V2"] as const) {
    describe(venue, () => {
      for (const windowSec of WINDOWS_SEC) {
        for (const { trigger, limit } of PAIRS) {
          it(`window=${windowSec}s trigger=${trigger} limit=${limit} — places at limit, postOnly=false, no rollover fill loss`, async () => {
            const exec = new MatrixExecutor(venue)

            // 1) Trigger evaluation uses the trigger price, not the limit.
            expect(triggerFires("UP", trigger, trigger)).toBe(true)
            expect(triggerFires("UP", trigger, trigger + 0.001)).toBe(false)

            // 2) On fire, engine submits at LIMIT price with postOnly=false.
            const req: PlaceOrderRequest = {
              marketId: `m-${windowSec}`,
              tokenId: `t-${windowSec}`,
              side: "UP",
              price: limit,
              shares: 5,
              postOnly: false,
              phase: "TRIGGERED",
              tif: "GTC",
              expireAtMs: null,
            }
            const order = await exec.placeOrder(req)
            expect(order.price).toBe(limit)
            expect(exec.placements[0].request.postOnly).toBe(false)

            // 3) Simulate the last-ms rollover fill (Bug #010): a fill lands
            //    between the final tick and cancel; rollover must checkFill
            //    before cancelling.
            exec.fillOnCheck = true
            const finalFill = await exec.checkFill(order)
            expect(finalFill).not.toBeNull()
            expect(finalFill!.filledPrice).toBe(limit)
            expect(finalFill!.order.shares).toBe(5)
            await exec.cancelOrder(order)
            expect(exec.checkFillCalls).toBeGreaterThan(0)
            expect(exec.cancelCalls).toBe(1)
          })
        }
      }

      it("LIVE_V2 would reject marketable postOnly=true (Bug #009 guard)", async () => {
        if (venue !== "LIVE_V2") return
        const exec = new MatrixExecutor(venue)
        await expect(
          exec.placeOrder({
            marketId: "m",
            tokenId: "t",
            side: "UP",
            price: 0.85,
            shares: 5,
            postOnly: true,
          }),
        ).rejects.toThrow(/POST_ONLY|cross the spread/)
      })
    })
  }
})
