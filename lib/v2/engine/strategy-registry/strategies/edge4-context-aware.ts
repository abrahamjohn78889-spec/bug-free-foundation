import { bandForPhase, directionWithDriftGuard, targetBid, type SniperDecision } from "../../strategy/sniper"
import type { Strategy, StrategyInputs, StrategyParams } from "../types"

// ============================================================
// EDGE 4 — CONTEXT-AWARE RULE MANUAL
//
// Locks out standard execution and only authorizes entry when
// exactly ONE selected sub-condition is satisfied:
//
//   C  T-10s Window Delta  — spot/implied divergence > 0.10%
//   D  Micro-Volume Spike  — volume > 1.5x trailing 30s average
//   E  T-3s Settlement Snipe — 0.25% spot safety buffer vs strike
// ============================================================

const TICK = 0.01

export const edge4: Strategy = {
  meta: {
    id: "edge4",
    code: "EDGE 4",
    name: "Context-Aware Rule Manual",
    tagline: "Conditional late-window authorizer",
    description:
      "Gates all entry behind one of three rules — T-10s divergence (C), micro-volume spike (D), or T-3s settlement buffer (E) — so orders only fire when the selected structural condition confirms.",
    liveReady: false,
    params: [
      {
        key: "rule",
        label: "Active Rule",
        kind: "select",
        options: [
          { value: "C", label: "C — T-10s Window Delta" },
          { value: "D", label: "D — Micro-Volume Spike" },
          { value: "E", label: "E — T-3s Settlement Sniper" },
        ],
        default: "C",
        help: "Which single sub-condition authorizes execution.",
      },
      { key: "divergencePct", label: "C: Divergence Threshold", kind: "number", min: 0.01, max: 1, step: 0.01, unit: "%", default: 0.1, help: "Spot vs implied-probability divergence required for rule C." },
      { key: "volumeMult", label: "D: Volume Multiplier", kind: "number", min: 1, max: 5, step: 0.1, unit: "x", default: 1.5, help: "Volume-spike multiple over the trailing 30s average for rule D." },
      { key: "safetyBufferPct", label: "E: Safety Buffer", kind: "number", min: 0.05, max: 1, step: 0.05, unit: "%", default: 0.25, help: "Spot safety buffer vs the strike line for rule E." },
    ],
  },

  decide(inputs: StrategyInputs, params: StrategyParams): SniperDecision {
    const rule = String(params.rule ?? "C")

    if (inputs.phase === "STOPPING") {
      return inputs.openOrder
        ? { action: "CANCEL", side: null, price: null, reason: "T-2s lockout", tif: null, expireAtMs: null }
        : { action: "HOLD", side: null, price: null, reason: "T-2s lockout", tif: null, expireAtMs: null }
    }
    if (inputs.hasPosition) return { action: "HOLD", side: null, price: null, reason: "position filled, riding", tif: null, expireAtMs: null }
    if (inputs.phase === "WAITING" || inputs.phase === "OFFLINE") {
      return inputs.openOrder
        ? { action: "CANCEL", side: null, price: null, reason: "outside window", tif: null, expireAtMs: null }
        : { action: "HOLD", side: null, price: null, reason: `rule ${rule}: awaiting late window`, tif: null, expireAtMs: null }
    }
    if (inputs.spot === null || inputs.strike === null) return { action: "HOLD", side: null, price: null, reason: "awaiting spot/strike", tif: null, expireAtMs: null }

    const side = directionWithDriftGuard(inputs.spot, inputs.strike, inputs.cfg.driftPaddingUsd)
    if (!side) return { action: "HOLD", side: null, price: null, reason: "drift guard holding", tif: null, expireAtMs: null }

    // ---- Evaluate the selected sub-condition ----
    let authorized = false
    let gateReason = ""

    if (rule === "C") {
      // Divergence between spot move off strike and implied probability.
      const implied = inputs.fairFor(side)
      const spotDivergencePct = Math.abs(inputs.spot - inputs.strike) / inputs.strike * 100
      const impliedDivergencePct = Math.abs(implied - 0.5) * 100
      const delta = Math.abs(spotDivergencePct - impliedDivergencePct)
      authorized = delta >= Number(params.divergencePct ?? 0.1)
      gateReason = `C delta ${delta.toFixed(2)}% vs ${Number(params.divergencePct ?? 0.1)}%`
    } else if (rule === "D") {
      const v = inputs.volume
      if (v?.last30sVolume != null && v?.trailingAvgVolume != null && v.trailingAvgVolume > 0) {
        const mult = v.last30sVolume / v.trailingAvgVolume
        authorized = mult >= Number(params.volumeMult ?? 1.5)
        gateReason = `D volume ${mult.toFixed(2)}x`
      } else {
        gateReason = "D awaiting volume feed"
      }
    } else if (rule === "E") {
      const bufferPct = Number(params.safetyBufferPct ?? 0.25)
      const distancePct = Math.abs(inputs.spot - inputs.strike) / inputs.strike * 100
      authorized = inputs.phase === "PRIORITY_2" && distancePct >= bufferPct
      gateReason = `E buffer ${distancePct.toFixed(2)}% vs ${bufferPct}% @ T-3s`
    }

    if (!authorized) return { action: "HOLD", side, price: null, reason: `rule ${rule} not met (${gateReason})`, tif: null, expireAtMs: null }

    const band = bandForPhase(inputs.phase, inputs.cfg)
    if (!band) return { action: "HOLD", side: null, price: null, reason: "no band for phase", tif: null, expireAtMs: null }
    const price = targetBid(inputs.fairFor(side), band, inputs.cfg.priceFloor, inputs.cfg.priceCeil)
    if (price === null) return { action: "HOLD", side, price: null, reason: "price outside range constraint", tif: null, expireAtMs: null }

    if (!inputs.openOrder) {
      return { action: "QUOTE", side, price, reason: `rule ${rule} authorized: ${side} @ $${price.toFixed(2)}`, tif: inputs.cfg.tif, expireAtMs: null }
    }
    if (inputs.openOrder.side !== side || Math.abs(inputs.openOrder.price - price) >= TICK) {
      return { action: "REPRICE", side, price, reason: `rule ${rule} reprice → ${side} $${price.toFixed(2)}`, tif: inputs.cfg.tif, expireAtMs: null }
    }
    return { action: "HOLD", side, price, reason: `rule ${rule} resting`, tif: null, expireAtMs: null }
  },
}
