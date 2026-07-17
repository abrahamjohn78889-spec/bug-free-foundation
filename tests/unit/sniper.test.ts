import { describe, it, expect } from "vitest"
import {
  phaseFor,
  bandForPhase,
  directionWithDriftGuard,
  targetBid,
  decide,
  type SniperInputs,
} from "@/lib/v2/engine/strategy/sniper"
import { DEFAULT_STRATEGY } from "@/lib/v2/engine/config"
import type { StrategyConfig } from "@/lib/v2/engine/types"

const cfg: StrategyConfig = {
  ...DEFAULT_STRATEGY,
  p1Band: { min: 0.9, max: 0.94 },
  p2Band: { min: 0.95, max: 0.99 },
  driftPaddingUsd: 12,
  priceFloor: 0.75,
  priceCeil: 0.99,
  tif: "GTC",
}

// ============================================================
// phaseFor — time-decay window machine
// ============================================================
describe("phaseFor", () => {
  it("is STOPPING inside the final 2s hold", () => {
    expect(phaseFor(2_000, cfg)).toBe("STOPPING")
    expect(phaseFor(500, cfg)).toBe("STOPPING")
  })
  it("is PRIORITY_2 between T-10s and T-2s", () => {
    expect(phaseFor(10_000, cfg)).toBe("PRIORITY_2")
    expect(phaseFor(3_000, cfg)).toBe("PRIORITY_2")
  })
  it("is PRIORITY_1 between T-20s and T-10s", () => {
    expect(phaseFor(20_000, cfg)).toBe("PRIORITY_1")
    expect(phaseFor(11_000, cfg)).toBe("PRIORITY_1")
  })
  it("is WAITING before the T-20s window opens", () => {
    expect(phaseFor(45_000, cfg)).toBe("WAITING")
  })
  it("disables time windows when p1WindowMs is 0", () => {
    const noWindow = { ...cfg, p1WindowMs: 0 }
    expect(phaseFor(45_000, noWindow)).toBe("WAITING")
    // P2 and STOPPING still apply
    expect(phaseFor(9_000, noWindow)).toBe("PRIORITY_2")
  })
})

describe("bandForPhase", () => {
  it("maps P1 and P2 to their bands", () => {
    expect(bandForPhase("PRIORITY_1", cfg)).toEqual(cfg.p1Band)
    expect(bandForPhase("PRIORITY_2", cfg)).toEqual(cfg.p2Band)
  })
  it("has no band for non-quoting phases", () => {
    expect(bandForPhase("STOPPING", cfg)).toBeNull()
    expect(bandForPhase("WAITING", cfg)).toBeNull()
  })
})

// ============================================================
// directionWithDriftGuard — delegates to the oracle guard
// ============================================================
describe("directionWithDriftGuard", () => {
  it("returns UP when spot clears strike upward", () => {
    expect(directionWithDriftGuard(100013, 100000, 12)).toBe("UP")
  })
  it("returns DOWN when spot clears strike downward", () => {
    expect(directionWithDriftGuard(99987, 100000, 12)).toBe("DOWN")
  })
  it("returns null inside the padding band", () => {
    expect(directionWithDriftGuard(100001, 100000, 12)).toBeNull()
  })
})

// ============================================================
// targetBid — one tick under fair, clamped to band + hard range
// ============================================================
describe("targetBid", () => {
  it("bids one tick under fair value when inside the band", () => {
    expect(targetBid(0.97, cfg.p2Band, 0.75, 0.99)).toBe(0.96)
  })
  it("clamps up to the band floor", () => {
    // fair - tick = 0.90, but band.min is 0.95
    expect(targetBid(0.91, cfg.p2Band, 0.75, 0.99)).toBe(0.95)
  })
  it("clamps down to the band ceiling", () => {
    // fair - tick = 0.995, band.max 0.94 -> 0.94
    expect(targetBid(0.999, cfg.p1Band, 0.75, 0.99)).toBe(0.94)
  })
  it("rejects (null) a price below the hard floor", () => {
    expect(targetBid(0.80, { min: 0.5, max: 0.6 }, 0.75, 0.99)).toBeNull()
  })
  it("rejects (null) a price above the hard ceiling", () => {
    expect(targetBid(1.5, { min: 0.995, max: 1.2 }, 0.75, 0.99)).toBeNull()
  })
})

// ============================================================
// decide — the full sniper decision matrix
// ============================================================
function baseInputs(overrides: Partial<SniperInputs> = {}): SniperInputs {
  return {
    phase: "PRIORITY_2",
    spot: 100050,
    strike: 100000,
    cfg,
    fairFor: () => 0.97,
    openOrder: null,
    hasPosition: false,
    ...overrides,
  }
}

describe("decide", () => {
  it("HOLDs and fires nothing during the STOPPING hold state", () => {
    const d = decide(baseInputs({ phase: "STOPPING" }))
    expect(d.action).toBe("HOLD")
    expect(d.side).toBeNull()
  })

  it("CANCELs a resting order when entering the STOPPING hold state", () => {
    const d = decide(
      baseInputs({ phase: "STOPPING", openOrder: { side: "UP", price: 0.96, placedAtMs: Date.now() } }),
    )
    expect(d.action).toBe("CANCEL")
  })

  it("HOLDs while a position is already filled (riding to expiry)", () => {
    const d = decide(baseInputs({ hasPosition: true }))
    expect(d.action).toBe("HOLD")
    expect(d.reason).toMatch(/riding to expiry/)
  })

  it("HOLDs when the drift guard finds no clear direction", () => {
    const d = decide(baseInputs({ spot: 100001 }))
    expect(d.action).toBe("HOLD")
    expect(d.reason).toMatch(/drift guard/)
  })

  it("QUOTEs a new maker order one tick under fair value on the cleared side", () => {
    const d = decide(baseInputs())
    expect(d.action).toBe("QUOTE")
    expect(d.side).toBe("UP")
    expect(d.price).toBe(0.96)
    expect(d.tif).toBe("GTC")
  })

  it("REPRICEs on a direction reversal against a resting order", () => {
    const d = decide(
      baseInputs({
        spot: 99950, // now DOWN
        fairFor: () => 0.97,
        openOrder: { side: "UP", price: 0.96, placedAtMs: Date.now() },
      }),
    )
    expect(d.action).toBe("REPRICE")
    expect(d.side).toBe("DOWN")
  })

  it("REPRICEs when the target price drifts at least one tick", () => {
    const d = decide(
      baseInputs({
        fairFor: () => 0.99, // target 0.98
        openOrder: { side: "UP", price: 0.96, placedAtMs: Date.now() },
      }),
    )
    expect(d.action).toBe("REPRICE")
    expect(d.price).toBe(0.98)
  })

  it("HOLDs a resting order that is already at the target level", () => {
    const d = decide(
      baseInputs({
        fairFor: () => 0.97, // target 0.96
        openOrder: { side: "UP", price: 0.96, placedAtMs: Date.now() },
      }),
    )
    expect(d.action).toBe("HOLD")
    expect(d.reason).toMatch(/resting at target/)
  })

  it("HOLDs (no quote) when the computed bid is outside the hard price range", () => {
    const d = decide(baseInputs({ cfg: { ...cfg, p2Band: { min: 0.5, max: 0.6 } }, fairFor: () => 0.6 }))
    expect(d.action).toBe("HOLD")
    expect(d.reason).toMatch(/price-range guard/)
  })
})
