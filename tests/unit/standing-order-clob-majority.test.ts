/**
 * Regression: CLOB-price majority is chosen at the exact moment of trigger
 * evaluation (spec: "The market direction should be determined at the exact
 * moment the trigger price is hit, not before"). Verifies:
 *  - computeMajority() returns the higher-priced side from the atomic snapshot
 *  - an exact tie returns null (HOLD, never guess)
 *  - the BTC-reference source path is preserved when the env opts out
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { StandingOrderManager } from "../../lib/v2/engine/standing-order"

// Access the private computeMajority via bracket cast for a focused unit test.
type AnyMgr = any // eslint-disable-line @typescript-eslint/no-explicit-any

function makeSnap(upPrice: number, downPrice: number) {
  return {
    up: { price: upPrice, bid: upPrice - 0.01, ask: upPrice, ageMs: 100 },
    down: { price: downPrice, bid: downPrice - 0.01, ask: downPrice, ageMs: 100 },
    upAgeMs: 100,
    downAgeMs: 100,
    timestampMs: Date.now(),
    generation: 1,
    confidence: "HIGH" as const,
  }
}

function mgr(): AnyMgr {
  // Minimal shim — computeMajority reads only the snapshot arg + env.
  return new StandingOrderManager({
    getMode: () => "PAPER",
    getBankroll: () => ({ balance: 100, dustReserve: 0 }),
    clobPriceFeed: {
      validatedQuotes: () => null,
      diagnostics: () => ({
        upQuoteAgeMs: null, downQuoteAgeMs: null, upTokenId: null,
        downTokenId: null, consecutiveFailures: 0, lastFailReason: "",
        lastSuccessMs: 0, generation: 0, validationFailReason: "",
      }),
      generation: 0,
    } as any,
  } as any)
}

describe("StandingOrderManager — CLOB-price majority at trigger", () => {
  const prev = process.env.STANDING_ORDER_MAJORITY_SOURCE
  beforeEach(() => { process.env.STANDING_ORDER_MAJORITY_SOURCE = "CLOB_AT_TRIGGER" })
  afterEach(() => {
    if (prev === undefined) delete process.env.STANDING_ORDER_MAJORITY_SOURCE
    else process.env.STANDING_ORDER_MAJORITY_SOURCE = prev
  })

  it("picks UP when up.price > down.price", () => {
    const m = mgr()
    expect(m.computeMajority(makeSnap(0.97, 0.05))).toEqual({ side: "UP", price: 0.97 })
  })

  it("picks DOWN when down.price > up.price", () => {
    const m = mgr()
    expect(m.computeMajority(makeSnap(0.04, 0.98))).toEqual({ side: "DOWN", price: 0.98 })
  })

  it("returns null on an exact tie (HOLD, never guess)", () => {
    const m = mgr()
    expect(m.computeMajority(makeSnap(0.5, 0.5))).toEqual({ side: null, price: 0 })
  })

  it("uses ONLY the passed snapshot — ignores BTC spot/strike in CLOB mode", () => {
    const m = mgr()
    // Even with no strike set, CLOB mode returns a decisive side.
    expect(m.computeMajority(makeSnap(0.6, 0.4)).side).toBe("UP")
  })

  it("BTC_REFERENCE env falls back to legacy path", () => {
    process.env.STANDING_ORDER_MAJORITY_SOURCE = "BTC_REFERENCE"
    const m = mgr()
    // With no strike/spot configured the legacy path returns null — this
    // confirms the CLOB branch is NOT taken when env opts out.
    expect(m.computeMajority(makeSnap(0.9, 0.1)).side).toBeNull()
  })
})
