import type { SniperDecision } from "../../strategy/sniper"
import type { Strategy, StrategyInputs, StrategyParams } from "../types"

// ============================================================
// EDGE 1 — 40/50 SEQUENTIAL MATCH ENGINE
//
// Exploits instant spread imbalance inside the active candle:
//   Leg 1: resting limit maker on DOWN @ <= $0.50 entry
//   Leg 2: the millisecond Leg 1 fills, fire UP @ $0.40
//   Reset: if Leg 1 fails / cancels, the chain resets
//
// Leg-2 sequencing and unhedged-leg recovery are coordinated by
// the engine's orphan-cleaner handler once Leg 1 reports FILLED.
// This module owns the Leg-1 entry decision.
// ============================================================

const TICK = 0.01

export const edge1: Strategy = {
  meta: {
    id: "edge1",
    code: "EDGE 1",
    name: "40/50 Sequential Match Engine",
    tagline: "Two-leg spread-imbalance capture",
    description:
      "Rests a DOWN maker at a $0.50 ceiling; the instant it fills, chains a $0.40 UP maker to lock the $0.10 spread. Unfilled legs reset the chain; a filled-but-unhedged leg triggers the orphan cleaner.",
    liveReady: false,
    params: [
      {
        key: "leg1Price",
        label: "Leg 1 DOWN Entry",
        kind: "number",
        min: 0.3,
        max: 0.6,
        step: 0.01,
        unit: "$",
        default: 0.5,
        help: "Maximum resting maker price for the first (DOWN) leg.",
      },
      {
        key: "leg2Price",
        label: "Leg 2 UP Entry",
        kind: "number",
        min: 0.2,
        max: 0.5,
        step: 0.01,
        unit: "$",
        default: 0.4,
        help: "Resting maker price for the chained (UP) leg after Leg 1 fills.",
      },
    ],
  },

  decide(inputs: StrategyInputs, params: StrategyParams): SniperDecision {
    const leg1 = Number(params.leg1Price ?? 0.5)
    const leg2 = Number(params.leg2Price ?? 0.4)

    // Phase 3 lockout: never fire into a closing slot.
    if (inputs.phase === "STOPPING") {
      return inputs.openOrder
        ? { action: "CANCEL", side: null, price: null, reason: "T-2s lockout: dropping Leg 1", tif: null, expireAtMs: null }
        : { action: "HOLD", side: null, price: null, reason: "T-2s lockout", tif: null, expireAtMs: null }
    }

    // Leg 1 already filled → engine rides / orphan cleaner hedges Leg 2.
    if (inputs.hasPosition) {
      return { action: "HOLD", side: null, price: null, reason: "Leg 1 filled — chaining Leg 2 UP @ $" + leg2.toFixed(2), tif: null, expireAtMs: null }
    }

    // Only hunt inside the active sniping window.
    if (inputs.phase === "WAITING" || inputs.phase === "OFFLINE") {
      return inputs.openOrder
        ? { action: "CANCEL", side: null, price: null, reason: "outside window: resetting chain", tif: null, expireAtMs: null }
        : { action: "HOLD", side: null, price: null, reason: "awaiting sniping window for Leg 1", tif: null, expireAtMs: null }
    }

    const downFair = inputs.fairFor("DOWN")
    const price = Math.round(Math.min(leg1, downFair - TICK) * 100) / 100
    if (price <= 0) {
      return { action: "HOLD", side: null, price: null, reason: "DOWN fair above Leg 1 ceiling", tif: null, expireAtMs: null }
    }

    if (!inputs.openOrder) {
      return { action: "QUOTE", side: "DOWN", price, reason: `Leg 1: resting DOWN @ $${price.toFixed(2)}`, tif: inputs.cfg.tif, expireAtMs: null }
    }
    if (Math.abs(inputs.openOrder.price - price) >= TICK) {
      return { action: "REPRICE", side: "DOWN", price, reason: `Leg 1 reprice → $${price.toFixed(2)}`, tif: inputs.cfg.tif, expireAtMs: null }
    }
    return { action: "HOLD", side: "DOWN", price, reason: "Leg 1 resting at target", tif: null, expireAtMs: null }
  },
}
