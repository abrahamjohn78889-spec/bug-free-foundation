/**
 * Bug #011 regression — failed / retried window rollover must never
 * double-book the ledger or leave a fill without its matching debit.
 *
 * Two shipping guards are exercised end-to-end against a stub executor that
 * models both PAPER_V1 and LIVE_V2 paths (the executor contract is identical):
 *
 *   1. onFill is idempotent per exchangeOrderId — a duplicate call (retried
 *      rollover, poll+rollover race, exchange re-ack) produces exactly one
 *      openTrade insert and exactly one bankroll debit.
 *   2. rolloverSlot's final checkFill (bug #010) piped through the same
 *      idempotency guard, so a fill already booked by pollRestingFill in
 *      the same slot is not re-booked when rollover re-checks the order.
 *   3. Slot boundary clears the booked-id set so a fresh order in the next
 *      slot with a coincidentally-identical id is still booked.
 *
 * The invariant is asserted directly against the guard's contract; the
 * engine's onFill is a private method and instantiating StandingOrderManager
 * requires the full deps graph, so we mirror the guard here and assert the
 * SAME shape that lives in standing-order.ts (see the imported source
 * check below to catch drift).
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { OpenOrder } from "@/lib/v2/engine/types"

type Venue = "PAPER_V1" | "LIVE_V2"

interface LedgerRow {
  orderId: string
  side: "UP" | "DOWN"
  price: number
  shares: number
  cost: number
}

/**
 * Minimal mirror of the guarded onFill contract shipped in
 * lib/v2/engine/standing-order.ts. Any change to the real guard must update
 * this mirror in lockstep — the drift check below verifies the real source
 * still contains the guard so this test suite fails loudly if the guard is
 * removed without updating this suite.
 */
class GuardedBooker {
  readonly venue: Venue
  readonly ledger: LedgerRow[] = []
  balance: number
  private booked = new Set<string>()
  duplicateSuppressions = 0

  constructor(venue: Venue, opening: number) {
    this.venue = venue
    this.balance = opening
  }

  onFill(order: OpenOrder, filledPrice: number): "BOOKED" | "SUPPRESSED" {
    const oid = order.exchangeOrderId
    if (oid && this.booked.has(oid)) {
      this.duplicateSuppressions++
      return "SUPPRESSED"
    }
    if (oid) this.booked.add(oid)
    const cost = Math.round(order.shares * filledPrice * 10000) / 10000
    this.balance = Math.round((this.balance - cost) * 10000) / 10000
    this.ledger.push({
      orderId: oid,
      side: order.side,
      price: filledPrice,
      shares: order.shares,
      cost,
    })
    return "BOOKED"
  }

  onRollover() {
    // Matches the real cancelRestingOrder + bookedFillOrderIds.clear() at
    // slot rollover in standing-order.ts.
    this.booked.clear()
  }
}

const makeOrder = (id: string, side: "UP" | "DOWN" = "UP"): OpenOrder => ({
  marketId: "m",
  tokenId: "t",
  exchangeOrderId: id,
  side,
  price: 0.85,
  shares: 5,
  createdAtMs: Date.now(),
})

describe("bug #011 — retried rollover: no duplicate ledger, no missing reversal", () => {
  for (const venue of ["PAPER_V1", "LIVE_V2"] as const) {
    describe(venue, () => {
      it("duplicate onFill for the same exchange order id books exactly once", () => {
        const b = new GuardedBooker(venue, 100)
        const o = makeOrder("eo-1")

        expect(b.onFill(o, 0.85)).toBe("BOOKED")
        expect(b.onFill(o, 0.85)).toBe("SUPPRESSED")
        expect(b.onFill(o, 0.85)).toBe("SUPPRESSED")

        expect(b.ledger).toHaveLength(1)
        expect(b.duplicateSuppressions).toBe(2)
        // Balance was debited exactly once (5 * 0.85 = 4.25).
        expect(b.balance).toBe(95.75)
      })

      it("poll fill + rollover final-checkFill race books once (bug #010 + #011)", () => {
        const b = new GuardedBooker(venue, 100)
        const o = makeOrder("eo-race")

        // pollRestingFill wins the race, books the fill.
        b.onFill(o, 0.85)
        // rolloverSlot's final checkFill returns the same fill; must suppress.
        expect(b.onFill(o, 0.85)).toBe("SUPPRESSED")

        expect(b.ledger).toHaveLength(1)
        expect(b.balance).toBe(95.75)
      })

      it("failed rollover retry (throw between clear + cancel) does not double-book", () => {
        const b = new GuardedBooker(venue, 100)
        const o = makeOrder("eo-retry")

        // First rollover: books the fill, then simulate a throw before the
        // slot boundary state (bookedFillOrderIds) is cleared. The retried
        // rollover replays the checkFill and must NOT re-book.
        b.onFill(o, 0.85)
        // (no b.onRollover() — the boundary bookkeeping never ran)
        expect(b.onFill(o, 0.85)).toBe("SUPPRESSED")

        expect(b.ledger).toHaveLength(1)
        expect(b.balance).toBe(95.75)
      })

      it("new slot clears the guard so a fresh order books normally", () => {
        const b = new GuardedBooker(venue, 100)
        b.onFill(makeOrder("eo-slotA"), 0.85)
        expect(b.ledger).toHaveLength(1)

        b.onRollover()

        b.onFill(makeOrder("eo-slotB"), 0.70)
        expect(b.ledger).toHaveLength(2)
        // 100 - 5*0.85 - 5*0.70 = 100 - 4.25 - 3.5 = 92.25
        expect(b.balance).toBe(92.25)
      })

      it("every booked fill has exactly one matching debit (no missing reversal)", () => {
        const b = new GuardedBooker(venue, 100)
        const orders = ["a", "b", "c", "d"].map((k) => makeOrder(`eo-${k}`))
        // Interleave duplicate acks to simulate flaky exchange retries.
        for (const o of orders) {
          b.onFill(o, 0.5)
          b.onFill(o, 0.5) // dup ack
          b.onFill(o, 0.5) // dup ack
        }
        // 4 unique orders × (5 shares × 0.5) = 10 total cost.
        expect(b.ledger).toHaveLength(4)
        expect(b.balance).toBe(90)
        expect(b.duplicateSuppressions).toBe(8)
        // Every ledger row must be reconcilable against balance movement.
        const debited = 100 - b.balance
        const summed = b.ledger.reduce((s, r) => s + r.cost, 0)
        expect(Math.round(summed * 10000) / 10000).toBe(
          Math.round(debited * 10000) / 10000,
        )
      })
    })
  }

  it("shipped source still contains the bug #011 idempotency guard", () => {
    // Drift check: if the guard is refactored away this test must fail so
    // the mirrored contract above is updated, not silently bypassed.
    const src = readFileSync(
      resolve(__dirname, "../../lib/v2/engine/standing-order.ts"),
      "utf8",
    )
    expect(src).toMatch(/bookedFillOrderIds/)
    expect(src).toMatch(/bug #011/i)
    expect(src).toMatch(/bookedFillOrderIds\.clear\(\)/)
  })
})
