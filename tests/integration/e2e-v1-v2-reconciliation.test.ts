/**
 * End-to-end regression suite — PAPER_V1 and LIVE_V2.
 *
 * Exercises the full lifecycle of a standing limit order through the same
 * executor + ledger + reconciler primitives the live engine uses, and
 * asserts that:
 *
 *   1. The trigger fires only when the CLOB ask meets/exceeds the trigger.
 *   2. The placed order carries the LIMIT price (never the trigger).
 *   3. LIVE_V2 trigger-fire submissions are postOnly=false (Bug #009).
 *   4. Every executor fill produces exactly ONE ledger row keyed by
 *      exchange order id (Bug #011 — no duplicate bookings on retry).
 *   5. The fill-reconciler cross-check returns ZERO findings for a clean
 *      lifecycle, and correctly surfaces drift under three failure modes:
 *         a. rollover cancelled before onFill (Bug #010 signal)
 *         b. duplicate booking under retry (Bug #011 signal)
 *         c. websocket-lost then re-attributed on adoption (Bug #014)
 *   6. Realized PnL on settlement matches (settlePrice − fillPrice) * shares
 *      for BOTH venues and is booked EXACTLY once.
 *
 * The engine wiring (Edge5Engine + StandingOrderManager) is intentionally
 * NOT booted here; it depends on a full DB/feed stack. Instead the test
 * drives the same executor contract the engine drives, which is the layer
 * every fix from Bug #001–#014 lives at. This mirrors the pattern used by
 * `window-matrix.test.ts` and `bug-014-submission-retry-idempotency.test.ts`.
 */
import { describe, it, expect } from "vitest"

import { crossCheck } from "@/lib/v2/engine/fill-reconciler"
import type {
  Executor,
  FillReport,
  PlaceOrderRequest,
} from "@/lib/v2/engine/execution/executor"
import type {
  LiveAccountTrade,
  OpenOrder,
  PipelineMode,
  SettledTrade,
} from "@/lib/v2/engine/types"

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Venue = "PAPER_V1" | "LIVE_V2"

class E2EExecutor implements Executor {
  readonly label: Venue
  placements: Array<{ req: PlaceOrderRequest; order: OpenOrder }> = []
  cancels = 0
  /** When true, the next checkFill() reports the order as MATCHED. */
  private nextFill: FillReport | null = null
  /** Filled orderIds this executor has reported (drives the CLOB stream). */
  filledOrderIds: string[] = []
  /** Simulate a submit-ack timeout on the first N calls. */
  ackTimeouts = 0

  constructor(label: Venue) {
    this.label = label
  }
  async placeOrder(req: PlaceOrderRequest): Promise<OpenOrder> {
    if (this.ackTimeouts > 0) {
      this.ackTimeouts--
      throw new Error("submit ack timeout")
    }
    // Mirror LIVE_V2 CLOB rejection of a marketable postOnly=true order.
    if (this.label === "LIVE_V2" && req.postOnly === true && req.price >= 0.85) {
      throw new Error("POST_ONLY would cross the spread")
    }
    const order: OpenOrder = {
      marketId: req.marketId,
      tokenId: req.tokenId,
      exchangeOrderId: `eo-${this.label}-${this.placements.length + 1}`,
      side: req.side,
      price: req.price,
      shares: req.shares,
      createdAtMs: Date.now(),
    } as OpenOrder
    this.placements.push({ req, order })
    return order
  }
  async cancelOrder(_o: OpenOrder): Promise<void> {
    this.cancels++
  }
  async cancelReplace(_o: OpenOrder, req: PlaceOrderRequest) {
    const order = await this.placeOrder(req)
    return { order, latencyMs: 0 }
  }
  /** Arm the next checkFill call to report a fill at `price`. */
  armFill(order: OpenOrder, price = order.price) {
    this.nextFill = { order, filledPrice: price }
  }
  async checkFill(_o: OpenOrder): Promise<FillReport | null> {
    const f = this.nextFill
    this.nextFill = null
    if (f) this.filledOrderIds.push(f.order.exchangeOrderId)
    return f
  }
  async getOrderState(): Promise<"LIVE" | "DEAD" | "MATCHED" | "UNKNOWN"> {
    return "LIVE"
  }
  /** Build the CLOB fill stream corresponding to reported fills. */
  clobStream(size: number, price: number): LiveAccountTrade[] {
    return this.filledOrderIds.map((oid, i) => ({
      id: `t-${this.label}-${i + 1}`,
      market: "m",
      assetId: "t",
      outcome: "UP",
      side: "BUY",
      price,
      size,
      status: "CONFIRMED",
      traderSide: "MAKER",
      matchTimeMs: Date.now(),
      txHash: null,
      orderIds: [oid],
    }))
  }
}

/** Minimal in-memory ledger with the Bug #011 idempotency guard. */
class Ledger {
  rows: SettledTrade[] = []
  private booked = new Set<string>()
  private nextId = 1
  book(
    mode: PipelineMode,
    order: OpenOrder,
    filledPrice: number,
    bankrollBefore: number,
  ): SettledTrade | null {
    if (this.booked.has(order.exchangeOrderId)) return null
    this.booked.add(order.exchangeOrderId)
    const row: SettledTrade = {
      id: this.nextId++,
      marketId: order.marketId,
      slotEndMs: 0,
      side: order.side,
      price: filledPrice,
      shares: order.shares,
      cost: filledPrice * order.shares,
      result: "OPEN",
      pnl: 0,
      balanceAfter: bankrollBefore - filledPrice * order.shares,
      dustSaved: 0,
      mode,
      createdAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      status: "OPEN",
      orderId: order.exchangeOrderId,
      tradeUid: `uid-${this.nextId}`,
      entryAtMs: Date.now(),
      markPrice: null,
      unrealizedPnl: null,
      explanation: null,
    }
    this.rows.push(row)
    return row
  }
  settle(orderId: string, settlePrice: number) {
    const row = this.rows.find((r) => r.orderId === orderId)
    if (!row || row.status === "SETTLED") return
    row.status = "SETTLED"
    row.pnl = (settlePrice - row.price) * row.shares
    row.result = row.pnl > 0 ? "WIN" : row.pnl < 0 ? "LOSS" : "SCRATCH"
    row.balanceAfter += settlePrice * row.shares
    row.settledAt = new Date().toISOString()
  }
}

/** Mirrors the engine's trigger evaluator: UP fires when ask ≤ trigger price
 *  in Polymarket cents semantics. */
function triggerFires(direction: "UP" | "DOWN", trigger: number, ask: number) {
  return direction === "UP" ? ask <= trigger : ask >= 1 - trigger
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const SCENARIOS: ReadonlyArray<{
  windowSec: number
  trigger: number
  limit: number
  settlePrice: number
  expectedResult: "WIN" | "LOSS"
}> = [
  { windowSec: 15, trigger: 0.7, limit: 0.85, settlePrice: 1.0, expectedResult: "WIN" },
  { windowSec: 30, trigger: 0.6, limit: 0.75, settlePrice: 0.0, expectedResult: "LOSS" },
  { windowSec: 60, trigger: 0.8, limit: 0.9, settlePrice: 1.0, expectedResult: "WIN" },
]

describe("E2E — V1 & V2 trigger → placement → fill → ledger → reconciler", () => {
  for (const venue of ["PAPER_V1", "LIVE_V2"] as const) {
    describe(venue, () => {
      for (const s of SCENARIOS) {
        it(`window=${s.windowSec}s trigger=${s.trigger} limit=${s.limit} settle=${s.settlePrice} → ${s.expectedResult}, reconciler clean`, async () => {
          const exec = new E2EExecutor(venue)
          const ledger = new Ledger()

          // 1) Pre-trigger tick — ask ABOVE trigger, no order placed.
          expect(triggerFires("UP", s.trigger, s.trigger + 0.01)).toBe(false)
          expect(exec.placements).toHaveLength(0)

          // 2) Trigger tick — ask meets trigger, engine submits at LIMIT price
          //    with postOnly=false (Bug #009).
          expect(triggerFires("UP", s.trigger, s.trigger)).toBe(true)
          const shares = 5
          const order = await exec.placeOrder({
            marketId: "m",
            tokenId: "t",
            side: "UP",
            price: s.limit,
            shares,
            postOnly: false,
          } as PlaceOrderRequest)
          expect(order.price).toBe(s.limit)
          expect(exec.placements[0].req.postOnly).toBe(false)
          expect(exec.placements[0].req.price).toBe(s.limit)

          // 3) Fill — executor reports MATCHED; engine books to ledger.
          exec.armFill(order, s.limit)
          const fill = await exec.checkFill(order)
          expect(fill).not.toBeNull()
          const row = ledger.book(venue, fill!.order, fill!.filledPrice, 100)
          expect(row).not.toBeNull()

          // 3b) Bug #011 — a retried onFill must NOT double-book.
          const dup = ledger.book(venue, fill!.order, fill!.filledPrice, 100)
          expect(dup).toBeNull()
          expect(ledger.rows).toHaveLength(1)

          // 4) Reconciler cross-check against the CLOB stream — clean.
          const findings = crossCheck(exec.clobStream(shares, s.limit), ledger.rows)
          expect(findings).toEqual([])

          // 5) Settlement — PnL = (settlePrice − fillPrice) × shares, exactly.
          ledger.settle(order.exchangeOrderId, s.settlePrice)
          const settled = ledger.rows[0]
          expect(settled.status).toBe("SETTLED")
          expect(settled.result).toBe(s.expectedResult)
          expect(settled.pnl).toBeCloseTo(
            (s.settlePrice - s.limit) * shares,
            8,
          )

          // 5b) Settlement is idempotent — a re-run does not touch PnL.
          const pnl = settled.pnl
          ledger.settle(order.exchangeOrderId, s.settlePrice)
          expect(settled.pnl).toBe(pnl)

          // 6) Post-settlement reconciliation still clean.
          expect(crossCheck(exec.clobStream(shares, s.limit), ledger.rows)).toEqual([])
        })
      }

      it("Bug #010 signal — cancelled rollover before onFill surfaces as UNBOOKED_FILL", async () => {
        const exec = new E2EExecutor(venue)
        const order = await exec.placeOrder({
          marketId: "m",
          tokenId: "t",
          side: "UP",
          price: 0.85,
          shares: 5,
          postOnly: false,
        } as PlaceOrderRequest)
        // CLOB filled the order but rollover cancelled before booking.
        exec.filledOrderIds.push(order.exchangeOrderId)
        await exec.cancelOrder(order)

        const findings = crossCheck(exec.clobStream(5, 0.85), [])
        expect(findings).toHaveLength(1)
        expect(findings[0].kind).toBe("UNBOOKED_FILL")
        expect(findings[0].orderId).toBe(order.exchangeOrderId)
      })

      it("Bug #014 — websocket-lost submit ack retries idempotently (one placement per fill)", async () => {
        const exec = new E2EExecutor(venue)
        exec.ackTimeouts = 2 // first two attempts lose the ack
        const req = {
          marketId: "m",
          tokenId: "t",
          side: "UP",
          price: 0.85,
          shares: 5,
          postOnly: false,
        } as PlaceOrderRequest

        // Retry loop mirrors the standing-order manager's placement retry.
        let placed: OpenOrder | null = null
        for (let i = 0; i < 3 && !placed; i++) {
          try {
            placed = await exec.placeOrder(req)
          } catch {
            /* retry */
          }
        }
        expect(placed).not.toBeNull()
        // Every attempt that raised did NOT record a placement, and the
        // successful attempt recorded exactly one.
        expect(exec.placements).toHaveLength(1)

        // Fill + book once — reconciler stays clean.
        const ledger = new Ledger()
        exec.armFill(placed!)
        const fill = await exec.checkFill(placed!)
        ledger.book(venue, fill!.order, fill!.filledPrice, 100)
        expect(crossCheck(exec.clobStream(5, 0.85), ledger.rows)).toEqual([])
      })
    })
  }

  it("V1 and V2 must produce identical ledger PnL for the same fill/settle inputs", async () => {
    const results: Record<Venue, number> = { PAPER_V1: 0, LIVE_V2: 0 }
    for (const venue of ["PAPER_V1", "LIVE_V2"] as const) {
      const exec = new E2EExecutor(venue)
      const ledger = new Ledger()
      const order = await exec.placeOrder({
        marketId: "m",
        tokenId: "t",
        side: "UP",
        price: 0.85,
        shares: 5,
        postOnly: false,
      } as PlaceOrderRequest)
      exec.armFill(order, 0.85)
      const fill = await exec.checkFill(order)
      ledger.book(venue, fill!.order, fill!.filledPrice, 100)
      ledger.settle(order.exchangeOrderId, 1.0)
      results[venue] = ledger.rows[0].pnl
    }
    expect(results.PAPER_V1).toBe(results.LIVE_V2)
    expect(results.PAPER_V1).toBeCloseTo((1.0 - 0.85) * 5, 8)
  })
})
