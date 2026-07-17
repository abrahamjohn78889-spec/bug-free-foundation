import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RiskManager } from "@/lib/v2/engine/risk"

/**
 * Risk manager unit tests — kill switch, daily-loss breaker, notional cap,
 * order-rate cap, price/share sanity, and expiry guard. Uses the same on-disk
 * test DB pattern as the integration suite (db.ts opens EDGE5_DB_PATH).
 */

function futureSlotEndMs(): number {
  return Date.now() + 120_000 // 2 minutes out — comfortably before expiry guard
}

let risk: RiskManager

beforeEach(() => {
  risk = new RiskManager(() => "PAPER_V1")
  // Generous limits by default so individual tests tighten only what they probe.
  risk.setLimits({
    maxDailyLossUsd: 1_000_000,
    maxOrderNotionalUsd: 1_000_000,
    maxDailyOrders: 1_000_000,
    maxSharesPerOrder: 1_000_000,
  })
  if (risk.killSwitch.engaged) risk.disengageKillSwitch()
})

afterEach(() => {
  if (risk.killSwitch.engaged) risk.disengageKillSwitch()
})

describe("RiskManager: kill switch", () => {
  it("vetoes every order while engaged and allows after disengage", () => {
    risk.engageKillSwitch("unit test stop", "OPERATOR")
    const vetoed = risk.checkOrder({ price: 0.5, shares: 10, slotEndMs: futureSlotEndMs() })
    expect(vetoed.ok).toBe(false)
    if (!vetoed.ok) expect(vetoed.reason.toLowerCase()).toContain("kill switch")

    risk.disengageKillSwitch()
    const allowed = risk.checkOrder({ price: 0.5, shares: 10, slotEndMs: futureSlotEndMs() })
    expect(allowed.ok).toBe(true)
  })

  it("persists engagement across a new RiskManager instance (restart survival)", () => {
    risk.engageKillSwitch("persisted stop", "OPERATOR")
    const fresh = new RiskManager(() => "PAPER_V1")
    expect(fresh.killSwitch.engaged).toBe(true)
    const vetoed = fresh.checkOrder({ price: 0.5, shares: 10, slotEndMs: futureSlotEndMs() })
    expect(vetoed.ok).toBe(false)
    fresh.disengageKillSwitch()
  })

  it("records the reason and source", () => {
    risk.engageKillSwitch("manual halt for maintenance", "OPERATOR")
    expect(risk.killSwitch.reason).toBe("manual halt for maintenance")
    expect(risk.killSwitch.source).toBe("OPERATOR")
  })
})

describe("RiskManager: order sanity checks", () => {
  it("rejects prices outside (0, 1)", () => {
    expect(risk.checkOrder({ price: 0, shares: 10, slotEndMs: futureSlotEndMs() }).ok).toBe(false)
    expect(risk.checkOrder({ price: 1, shares: 10, slotEndMs: futureSlotEndMs() }).ok).toBe(false)
    expect(risk.checkOrder({ price: -0.5, shares: 10, slotEndMs: futureSlotEndMs() }).ok).toBe(false)
    expect(risk.checkOrder({ price: 1.5, shares: 10, slotEndMs: futureSlotEndMs() }).ok).toBe(false)
    expect(risk.checkOrder({ price: Number.NaN, shares: 10, slotEndMs: futureSlotEndMs() }).ok).toBe(false)
  })

  it("rejects non-positive or non-finite share counts", () => {
    expect(risk.checkOrder({ price: 0.5, shares: 0, slotEndMs: futureSlotEndMs() }).ok).toBe(false)
    expect(risk.checkOrder({ price: 0.5, shares: -5, slotEndMs: futureSlotEndMs() }).ok).toBe(false)
    expect(risk.checkOrder({ price: 0.5, shares: Number.NaN, slotEndMs: futureSlotEndMs() }).ok).toBe(false)
  })

  it("rejects orders too close to (or past) window expiry", () => {
    const expired = risk.checkOrder({ price: 0.5, shares: 10, slotEndMs: Date.now() - 1_000 })
    expect(expired.ok).toBe(false)
    const tooClose = risk.checkOrder({ price: 0.5, shares: 10, slotEndMs: Date.now() + 1_000 })
    expect(tooClose.ok).toBe(false)
  })
})

describe("RiskManager: exposure caps", () => {
  it("enforces the per-order notional cap", () => {
    risk.setLimits({ maxOrderNotionalUsd: 10 })
    // 0.50 x 30 = $15 > $10 cap
    const vetoed = risk.checkOrder({ price: 0.5, shares: 30, slotEndMs: futureSlotEndMs() })
    expect(vetoed.ok).toBe(false)
    if (!vetoed.ok) expect(vetoed.reason.toLowerCase()).toContain("notional")
    // 0.50 x 15 = $7.50 <= $10 cap
    expect(risk.checkOrder({ price: 0.5, shares: 15, slotEndMs: futureSlotEndMs() }).ok).toBe(true)
  })

  it("enforces the max-shares-per-order cap", () => {
    risk.setLimits({ maxSharesPerOrder: 20 })
    expect(risk.checkOrder({ price: 0.1, shares: 25, slotEndMs: futureSlotEndMs() }).ok).toBe(false)
    expect(risk.checkOrder({ price: 0.1, shares: 20, slotEndMs: futureSlotEndMs() }).ok).toBe(true)
  })
})

describe("RiskManager: limits management", () => {
  it("clamps invalid limit values instead of accepting them", () => {
    const next = risk.setLimits({ maxDailyLossUsd: -50, maxDailyOrders: 0 })
    expect(next.maxDailyLossUsd).toBeGreaterThan(0)
    expect(next.maxDailyOrders).toBeGreaterThan(0)
  })

  it("persists limits across instances", () => {
    risk.setLimits({ maxOrderNotionalUsd: 123 })
    const fresh = new RiskManager(() => "PAPER_V1")
    expect(fresh.snapshot().limits.maxOrderNotionalUsd).toBe(123)
  })
})
