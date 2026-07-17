import { describe, expect, it } from "vitest"
import { DEFAULT_CHAOS, PaperExecutor, ZERO_CHAOS } from "../../lib/v2/engine/execution/paper"

/**
 * BUG #6 — paper simulator was inventing partial fills that reduced a
 * FIXED_SHARES=7 order to 2 or 3 shares in the ledger (see image-7.png).
 * Default chaos must NOT synthesize partial fills; a 7-share order at a liquid
 * $0.90-$1.00 book always fills fully on real Polymarket, and simulating
 * otherwise both violates the FIXED_SHARES contract and understates the
 * bankroll the next PERCENT slot compounds from.
 */
describe("BUG #6 · paper executor default chaos", () => {
  it("DEFAULT_CHAOS.partialFillRate is 0 so FIXED_SHARES fills fully", () => {
    expect(DEFAULT_CHAOS.partialFillRate).toBe(0)
  })

  it("ZERO_CHAOS remains fully deterministic for tests", () => {
    expect(ZERO_CHAOS.partialFillRate).toBe(0)
    expect(ZERO_CHAOS.rejectRate).toBe(0)
    expect(ZERO_CHAOS.timeoutRate).toBe(0)
  })

  it("chaos machinery is still opt-in via constructor override", () => {
    const exec = new PaperExecutor(() => 0.97, { chaos: { partialFillRate: 0.5 } })
    expect(exec.chaos.partialFillRate).toBe(0.5)
  })
})
