import { describe, it, expect } from "vitest"
import { validateOrderSize } from "@/lib/v2/engine/handlers/protocol-validator"
import { computeCompounding, shouldSweepDust } from "@/lib/v2/engine/handlers/dust-compounding"
import { detectOrphan, buildOrphanCounter } from "@/lib/v2/engine/handlers/orphan-cleaner"
import { classifyCancelReplace, shouldCancelReplace } from "@/lib/v2/engine/handlers/cancel-replace-pipeline"
import { evaluateOracleGuard } from "@/lib/v2/engine/handlers/oracle-sync-guard"

// ============================================================
// Handler 3.5 — 5-share protocol guard
// ============================================================
describe("validateOrderSize (5-share protocol guard)", () => {
  it("rejects a non-positive price", () => {
    const r = validateOrderSize(100, 0, 5)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/invalid price/)
  })

  it("rejects an empty capital pool", () => {
    const r = validateOrderSize(0, 0.9, 5)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/empty capital pool/)
  })

  it("passes when floored shares clear the minimum", () => {
    // 100 / 0.90 = 111 shares
    const r = validateOrderSize(100, 0.9, 5)
    expect(r.ok).toBe(true)
    expect(r.shares).toBe(111)
    expect(r.scaled).toBe(false)
    expect(r.requiredCapital).toBe(0)
  })

  it("floors fractional share counts (never rounds up)", () => {
    // 4.99 / 0.90 = 5.54 -> floor 5
    const r = validateOrderSize(4.99, 0.9, 5)
    expect(r.shares).toBe(5)
    expect(r.ok).toBe(true)
  })

  it("flags a scale-up when capital is just under the minimum and top-up is affordable", () => {
    // 4.0 / 0.90 = 4.44 -> 4 shares, under 5. Need 5 * 0.90 = 4.50
    const r = validateOrderSize(4.0, 0.9, 5, 10)
    expect(r.ok).toBe(false)
    expect(r.scaled).toBe(true)
    expect(r.shares).toBe(5)
    expect(r.requiredCapital).toBeCloseTo(4.5, 2)
  })

  it("refuses to scale when the required top-up exceeds maxCapital", () => {
    const r = validateOrderSize(4.0, 0.9, 5, 4.0)
    expect(r.ok).toBe(false)
    expect(r.scaled).toBe(false)
    expect(r.reason).toMatch(/insufficient capital/)
  })

  it("rounds required capital up to the cent so it always clears the floor", () => {
    // 5 * 0.333 = 1.665 -> ceil to 1.67
    const r = validateOrderSize(1.0, 0.333, 5, 100)
    expect(r.requiredCapital).toBe(1.67)
  })
})

// ============================================================
// Handler 3.3 — compounding & dust sweep
// ============================================================
describe("computeCompounding (dust sweep)", () => {
  it("returns null for a non-positive price", () => {
    expect(computeCompounding(100, 0, 0, 5)).toBeNull()
  })

  it("returns null when floored shares fall below the minimum", () => {
    // 2 / 0.9 = 2.2 -> 2 shares < 5
    expect(computeCompounding(2, 0, 0.9, 5)).toBeNull()
  })

  it("floors the pool into whole shares and sweeps the remainder as dust", () => {
    // pool 10.00 @ 0.90 -> 11 shares, cost 9.90, dust 0.10
    const r = computeCompounding(10, 0, 0.9, 5)
    expect(r).not.toBeNull()
    expect(r!.shares).toBe(11)
    expect(r!.cost).toBeCloseTo(9.9, 4)
    expect(r!.dust).toBeCloseTo(0.1, 4)
    expect(r!.capitalPool).toBeCloseTo(10, 4)
  })

  it("rolls the prior dust reserve back into the capital pool", () => {
    // balance 9.90 + dust 0.20 = 10.10 pool @ 0.90 -> 11 shares
    const r = computeCompounding(9.9, 0.2, 0.9, 5)
    expect(r!.capitalPool).toBeCloseTo(10.1, 4)
    expect(r!.shares).toBe(11)
  })

  it("never produces negative dust", () => {
    const r = computeCompounding(9, 0, 0.9, 5)
    expect(r!.dust).toBeGreaterThanOrEqual(0)
  })
})

describe("shouldSweepDust", () => {
  it("sweeps once the reserve reaches the threshold", () => {
    expect(shouldSweepDust(1.0, 1.0)).toBe(true)
    expect(shouldSweepDust(1.5, 1.0)).toBe(true)
  })
  it("holds below the threshold", () => {
    expect(shouldSweepDust(0.99, 1.0)).toBe(false)
  })
  it("never sweeps on a non-positive threshold", () => {
    expect(shouldSweepDust(5, 0)).toBe(false)
  })
})

// ============================================================
// Handler 3.4 — orphan asset cleaner
// ============================================================
describe("detectOrphan", () => {
  it("detects an orphan when leg1 filled and leg2 was rejected", () => {
    expect(detectOrphan("FILLED", "REJECTED")).toBe(true)
  })
  it("detects an orphan when leg1 filled and leg2 never placed", () => {
    expect(detectOrphan("FILLED", "NONE")).toBe(true)
  })
  it("is not an orphan while leg2 is still pending", () => {
    expect(detectOrphan("FILLED", "PENDING")).toBe(false)
  })
  it("is not an orphan when leg1 never filled", () => {
    expect(detectOrphan("REJECTED", "REJECTED")).toBe(false)
  })
})

describe("buildOrphanCounter", () => {
  it("flattens an orphaned UP leg by crossing the DOWN side", () => {
    const c = buildOrphanCounter("UP", 10, 0.876)
    expect(c.side).toBe("DOWN")
    expect(c.shares).toBe(10)
    expect(c.price).toBe(0.88) // rounded to the cent
    expect(c.type).toBe("FOK_MARKET")
    expect(c.urgency).toBe("CRITICAL")
  })
  it("flattens an orphaned DOWN leg by crossing the UP side", () => {
    const c = buildOrphanCounter("DOWN", 7, 0.42)
    expect(c.side).toBe("UP")
    expect(c.shares).toBe(7)
  })
})

// ============================================================
// Handler 3.2 — cancel/replace latency + trigger
// ============================================================
describe("classifyCancelReplace", () => {
  it("marks a round-trip within budget", () => {
    const r = classifyCancelReplace(80, 100)
    expect(r.withinBudget).toBe(true)
  })
  it("treats exactly-at-budget as within budget", () => {
    expect(classifyCancelReplace(100, 100).withinBudget).toBe(true)
  })
  it("flags an over-budget round-trip as adverse-selection risk", () => {
    const r = classifyCancelReplace(140, 100)
    expect(r.withinBudget).toBe(false)
    expect(r.reason).toMatch(/adverse-selection/)
  })
})

describe("shouldCancelReplace", () => {
  it("pulls the quote on a direction flip", () => {
    expect(shouldCancelReplace("UP", 0.95, "DOWN", 0.95)).toBe(true)
  })
  it("pulls the quote when the price moved at least one tick", () => {
    expect(shouldCancelReplace("UP", 0.95, "UP", 0.96)).toBe(true)
  })
  it("holds when the same side sits within a tick", () => {
    expect(shouldCancelReplace("UP", 0.95, "UP", 0.955)).toBe(false)
  })
})

// ============================================================
// Handler 3.1 — oracle sync drift guard
// ============================================================
describe("evaluateOracleGuard (drift guard)", () => {
  it("holds while spot or strike is missing", () => {
    expect(evaluateOracleGuard(null, 100000, 12).side).toBeNull()
    expect(evaluateOracleGuard(100000, null, 12).side).toBeNull()
  })

  it("holds when the spot tape is stale", () => {
    const now = 1_000_000
    const r = evaluateOracleGuard(100050, 100000, 12, now - 11_000, now)
    expect(r.side).toBeNull()
    expect(r.reason).toMatch(/stale/)
  })

  it("clears UP once spot rises past strike + padding", () => {
    const r = evaluateOracleGuard(100013, 100000, 12)
    expect(r.side).toBe("UP")
    expect(r.cleared).toBe(true)
    expect(r.distanceUsd).toBeCloseTo(13, 2)
  })

  it("clears DOWN once spot falls past strike - padding", () => {
    const r = evaluateOracleGuard(99987, 100000, 12)
    expect(r.side).toBe("DOWN")
    expect(r.cleared).toBe(true)
  })

  it("holds inside the padding band (the coin-flip zone)", () => {
    const r = evaluateOracleGuard(100005, 100000, 12)
    expect(r.side).toBeNull()
    expect(r.cleared).toBe(false)
  })

  it("treats exactly strike + padding as cleared (inclusive boundary)", () => {
    const r = evaluateOracleGuard(100012, 100000, 12)
    expect(r.side).toBe("UP")
  })

  it("accepts a fresh tape within the staleness window", () => {
    const now = 1_000_000
    const r = evaluateOracleGuard(100050, 100000, 12, now - 5_000, now)
    expect(r.side).toBe("UP")
  })
})
