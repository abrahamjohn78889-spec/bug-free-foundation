import { describe, it, expect } from "vitest"
import { modelUpProbability, tokenPrices } from "@/lib/v2/engine/market-model"
import { currentSlotEndMs, tMinusMs, marketIdForSlot } from "@/lib/v2/engine/clock"
import { clampBand, SLOT_MS } from "@/lib/v2/engine/config"

// ============================================================
// market-model — paper fair-value curve
// ============================================================
describe("modelUpProbability", () => {
  it("is 0.5 at the money (spot == strike)", () => {
    expect(modelUpProbability(100000, 100000, 60_000)).toBeCloseTo(0.5, 6)
  })

  it("rises above 0.5 when spot is above strike", () => {
    expect(modelUpProbability(100050, 100000, 60_000)).toBeGreaterThan(0.5)
  })

  it("falls below 0.5 when spot is below strike", () => {
    expect(modelUpProbability(99950, 100000, 60_000)).toBeLessThan(0.5)
  })

  it("stays within the clamped [0.001, 0.999] bounds even at extremes", () => {
    expect(modelUpProbability(200000, 100000, 1_000)).toBeLessThanOrEqual(0.999)
    expect(modelUpProbability(1, 100000, 1_000)).toBeGreaterThanOrEqual(0.001)
  })

  it("sharpens toward the boundary as expiry approaches", () => {
    const far = modelUpProbability(100050, 100000, 120_000)
    const near = modelUpProbability(100050, 100000, 3_000)
    // Same positive edge, less time -> more decisive (closer to 1).
    expect(near).toBeGreaterThan(far)
  })
})

describe("tokenPrices", () => {
  it("splits ~50/50 at the money", () => {
    const { up, down } = tokenPrices(100000, 100000, 60_000)
    expect(up).toBe(0.5)
    expect(down).toBe(0.5)
  })

  it("keeps up + down within a rounding cent of 1.00", () => {
    const { up, down } = tokenPrices(100037, 100000, 42_000)
    expect(up + down).toBeGreaterThanOrEqual(0.99)
    expect(up + down).toBeLessThanOrEqual(1.01)
  })
})

// ============================================================
// clock — slot geometry
// ============================================================
describe("clock slot geometry", () => {
  it("aligns the slot end to a 5-minute boundary", () => {
    expect(currentSlotEndMs() % SLOT_MS).toBe(0)
  })

  it("reports a remaining time inside (0, SLOT_MS]", () => {
    const t = tMinusMs()
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThanOrEqual(SLOT_MS)
  })

  it("formats a deterministic UTC market id for a given slot", () => {
    const slot = Date.UTC(2026, 0, 2, 3, 5, 0) // 2026-01-02 03:05:00Z
    expect(marketIdForSlot(slot)).toBe("BTC-5M-20260102-0305")
  })

  it("zero-pads month, day, hour and minute", () => {
    const slot = Date.UTC(2026, 8, 9, 8, 5, 0) // 2026-09-09 08:05:00Z
    expect(marketIdForSlot(slot)).toBe("BTC-5M-20260909-0805")
  })
})

// ============================================================
// config — band clamp
// ============================================================
describe("clampBand", () => {
  it("clamps the minimum up to the 0.50 floor", () => {
    expect(clampBand(0.3, 0.94)).toEqual({ min: 0.5, max: 0.94 })
  })
  it("clamps the maximum down to the 0.99 ceiling", () => {
    expect(clampBand(0.9, 1.5)).toEqual({ min: 0.9, max: 0.99 })
  })
  it("forces max to be at least min when inverted", () => {
    expect(clampBand(0.95, 0.9)).toEqual({ min: 0.95, max: 0.95 })
  })
})
