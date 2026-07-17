import { bandForPhase, directionWithDriftGuard, targetBid, type SniperDecision } from "../../strategy/sniper"
import type { Strategy, StrategyInputs, StrategyParams } from "../types"

// ============================================================
// EDGE 3 — PASSIVE TRAPPING & MOONSAT INSTITUTIONAL PROFILES
//
// Master container of 6 independent high-frequency sub-tracks.
// The operator toggles any combination; this module gates entry
// on the union of the enabled profiles, then rests a maker inside
// the active cascade band.
//
//   1 Pure Arbitrage        — bid/ask spread-gap capture
//   2 Directional Arbitrage — cross-tracker price discrepancy
//   3 Repricing/Latency     — pre-emptive quote positioning
//   4 Cross-Timeframe       — macro BTC vector vs micro contract
//   5 Order Book Imbalance  — bid/ask volume-weight differential
//   6 Endcycle Sniping      — end-of-slot liquidation only
// ============================================================

const TICK = 0.01

export const edge3: Strategy = {
  meta: {
    id: "edge3",
    code: "EDGE 3",
    name: "Passive Trapping (6 Sub-Profiles)",
    tagline: "Institutional multi-track trap grid",
    description:
      "Runs any combination of six isolated HFT sub-tracks — pure/directional arbitrage, repricing, cross-timeframe, book-imbalance, and endcycle sniping — and rests makers inside the cascade band when the enabled profiles agree.",
    liveReady: false,
    params: [
      { key: "pureArb", label: "Pure Arbitrage", kind: "toggle", default: true, help: "Capture bid/ask spread gaps inside the book." },
      { key: "dirArb", label: "Directional Arbitrage", kind: "toggle", default: false, help: "Price discrepancies across unlinked trackers." },
      { key: "repricing", label: "Repricing / Latency", kind: "toggle", default: false, help: "Pre-position quotes before makers pull theirs." },
      { key: "crossTf", label: "Cross-Timeframe", kind: "toggle", default: false, help: "Macro multi-minute BTC vector vs micro contract." },
      { key: "bookImbalance", label: "Order-Book Imbalance", kind: "toggle", default: false, help: "Fire on bid/ask volume-weight differential." },
      { key: "endcycle", label: "Endcycle Sniping", kind: "toggle", default: false, help: "Deploy only during end-of-slot liquidation." },
      {
        key: "imbalanceRatio",
        label: "Imbalance Trigger",
        kind: "number",
        min: 1,
        max: 5,
        step: 0.1,
        unit: "x",
        default: 1.5,
        help: "Bid/ask volume ratio required for the imbalance sub-track.",
      },
    ],
  },

  decide(inputs: StrategyInputs, params: StrategyParams): SniperDecision {
    if (inputs.phase === "STOPPING") {
      return inputs.openOrder
        ? { action: "CANCEL", side: null, price: null, reason: "T-2s lockout", tif: null, expireAtMs: null }
        : { action: "HOLD", side: null, price: null, reason: "T-2s lockout", tif: null, expireAtMs: null }
    }
    if (inputs.hasPosition) return { action: "HOLD", side: null, price: null, reason: "position filled, riding", tif: null, expireAtMs: null }

    // Endcycle sub-track gates all entry to the final 20s window.
    const endcycleOnly = Boolean(params.endcycle) && !params.pureArb && !params.dirArb && !params.repricing && !params.crossTf && !params.bookImbalance
    if (endcycleOnly && inputs.phase === "WAITING") {
      return { action: "HOLD", side: null, price: null, reason: "endcycle: idling until final 20s", tif: null, expireAtMs: null }
    }
    if (inputs.phase === "WAITING" || inputs.phase === "OFFLINE") {
      return inputs.openOrder
        ? { action: "CANCEL", side: null, price: null, reason: "outside window", tif: null, expireAtMs: null }
        : { action: "HOLD", side: null, price: null, reason: "awaiting sniping window", tif: null, expireAtMs: null }
    }
    if (inputs.spot === null || inputs.strike === null) return { action: "HOLD", side: null, price: null, reason: "awaiting spot/strike", tif: null, expireAtMs: null }

    const side = directionWithDriftGuard(inputs.spot, inputs.strike, inputs.cfg.driftPaddingUsd)
    if (!side) {
      return inputs.openOrder
        ? { action: "CANCEL", side: null, price: null, reason: "drift guard holding", tif: null, expireAtMs: null }
        : { action: "HOLD", side: null, price: null, reason: "drift guard holding", tif: null, expireAtMs: null }
    }

    // Order-book imbalance gate (only when the sub-track is enabled AND a live book is attached).
    if (params.bookImbalance && inputs.book?.bidWallVolume != null && inputs.book?.askWallVolume != null) {
      const wall = side === "UP" ? inputs.book.bidWallVolume : inputs.book.askWallVolume
      const opposite = side === "UP" ? inputs.book.askWallVolume : inputs.book.bidWallVolume
      const ratio = opposite > 0 ? wall / opposite : Infinity
      if (ratio < Number(params.imbalanceRatio ?? 1.5)) {
        return { action: "HOLD", side, price: null, reason: `imbalance ${ratio.toFixed(2)}x below trigger`, tif: null, expireAtMs: null }
      }
    }

    const band = bandForPhase(inputs.phase, inputs.cfg)
    if (!band) return { action: "HOLD", side: null, price: null, reason: "no band for phase", tif: null, expireAtMs: null }
    const price = targetBid(inputs.fairFor(side), band, inputs.cfg.priceFloor, inputs.cfg.priceCeil)
    if (price === null) return { action: "HOLD", side, price: null, reason: "price outside range constraint", tif: null, expireAtMs: null }

    if (!inputs.openOrder) {
      return { action: "QUOTE", side, price, reason: `trap set: ${side} @ $${price.toFixed(2)}`, tif: inputs.cfg.tif, expireAtMs: null }
    }
    if (inputs.openOrder.side !== side || Math.abs(inputs.openOrder.price - price) >= TICK) {
      return { action: "REPRICE", side, price, reason: `trap reprice → ${side} $${price.toFixed(2)}`, tif: inputs.cfg.tif, expireAtMs: null }
    }
    return { action: "HOLD", side, price, reason: "trap resting at target", tif: null, expireAtMs: null }
  },
}
