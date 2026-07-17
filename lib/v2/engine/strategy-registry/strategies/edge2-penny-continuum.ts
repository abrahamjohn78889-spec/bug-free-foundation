import { directionWithDriftGuard, type SniperDecision } from "../../strategy/sniper"
import type { Strategy, StrategyInputs, StrategyParams } from "../types"

// ============================================================
// EDGE 2 — CUSTOMIZABLE PENNY CONTINUUM ($0.80 - $0.99)
//
// Low-latency price-tracking algorithm. Continuously maps the
// live book; the millisecond either token strikes the operator's
// penny-perfect target boundary, it fires an optimized FOK maker
// onto that exact cent. Latency is tracked to the millisecond by
// the engine's cancel-replace pipeline.
// ============================================================

const TICK = 0.01

export const edge2: Strategy = {
  meta: {
    id: "edge2",
    code: "EDGE 2",
    name: "Penny Continuum Tracker",
    tagline: "Penny-perfect boundary striker",
    description:
      "Tracks book depth continuously and fires the instant a token touches a user-defined penny target between $0.80 and $0.99. Uses the drift guard for side selection and pins the order to the exact target cent.",
    liveReady: false,
    params: [
      {
        key: "targetPrice",
        label: "Target Penny",
        kind: "number",
        min: 0.8,
        max: 0.99,
        step: 0.01,
        unit: "$",
        default: 0.92,
        help: "Exact cent boundary that triggers a maker order when touched.",
      },
      {
        key: "tolerance",
        label: "Touch Tolerance",
        kind: "number",
        min: 0,
        max: 0.05,
        step: 0.01,
        unit: "$",
        default: 0.01,
        help: "How close the token price must come to the target before firing.",
      },
    ],
  },

  decide(inputs: StrategyInputs, params: StrategyParams): SniperDecision {
    const target = Number(params.targetPrice ?? 0.92)
    const tol = Number(params.tolerance ?? 0.01)

    if (inputs.phase === "STOPPING") {
      return inputs.openOrder
        ? { action: "CANCEL", side: null, price: null, reason: "T-2s lockout", tif: null, expireAtMs: null }
        : { action: "HOLD", side: null, price: null, reason: "T-2s lockout", tif: null, expireAtMs: null }
    }
    if (inputs.hasPosition) return { action: "HOLD", side: null, price: null, reason: "position filled, riding", tif: null, expireAtMs: null }
    if (inputs.spot === null || inputs.strike === null) return { action: "HOLD", side: null, price: null, reason: "awaiting spot/strike", tif: null, expireAtMs: null }

    const side = directionWithDriftGuard(inputs.spot, inputs.strike, inputs.cfg.driftPaddingUsd)
    if (!side) {
      return inputs.openOrder
        ? { action: "CANCEL", side: null, price: null, reason: "drift guard: no clear side", tif: null, expireAtMs: null }
        : { action: "HOLD", side: null, price: null, reason: "drift guard: no clear side", tif: null, expireAtMs: null }
    }

    const tokenPrice = inputs.fairFor(side)
    const distance = Math.abs(tokenPrice - target)
    if (distance > tol) {
      return { action: "HOLD", side, price: null, reason: `${side} @ $${tokenPrice.toFixed(2)} — waiting for $${target.toFixed(2)} touch`, tif: null, expireAtMs: null }
    }

    const price = Math.round(target * 100) / 100
    if (!inputs.openOrder) {
      return { action: "QUOTE", side, price, reason: `penny touch: firing ${side} @ $${price.toFixed(2)}`, tif: inputs.cfg.tif, expireAtMs: null }
    }
    if (inputs.openOrder.side !== side || Math.abs(inputs.openOrder.price - price) >= TICK) {
      return { action: "REPRICE", side, price, reason: `penny reprice → ${side} $${price.toFixed(2)}`, tif: inputs.cfg.tif, expireAtMs: null }
    }
    return { action: "HOLD", side, price, reason: "pinned to target penny", tif: null, expireAtMs: null }
  },
}
