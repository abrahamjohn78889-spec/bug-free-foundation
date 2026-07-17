import { bandForPhase, directionWithDriftGuard, targetBid, type SniperDecision } from "../../strategy/sniper"
import type { Strategy, StrategyInputs, StrategyParams } from "../types"

// ============================================================
// EDGE 6 — HIGH-CONVICTION BOOK-DEPTH ALPHA STREAMER
//
// Institutional risk filter. Monitors the full $0.80-$0.99
// spectrum but blocks submission unless the book shows a
// Bid-Ask Wall Volume Ratio above the threshold (default 2.0x),
// cross-validated by external alpha (funding, delta skew,
// liquidation clusters). Rejects on any reversal signal.
// ============================================================

const TICK = 0.01

export const edge6: Strategy = {
  meta: {
    id: "edge6",
    code: "EDGE 6",
    name: "Book-Depth Alpha Streamer",
    tagline: "Wall-ratio gated high-conviction maker",
    description:
      "Only submits when the order book shows a bid/ask wall ratio above the threshold and external alpha (funding premium, delta skew, liquidation clusters) confirms the side. Any reversal signal vetoes the trade.",
    liveReady: false,
    params: [
      { key: "wallRatio", label: "Wall Ratio Gate", kind: "number", min: 1, max: 6, step: 0.1, unit: "x", default: 2, help: "Minimum bid/ask wall volume ratio required to submit." },
      { key: "useFunding", label: "Funding Confirm", kind: "toggle", default: true, help: "Require perpetual funding premium to agree with the side." },
      { key: "useDeltaSkew", label: "Delta-Skew Confirm", kind: "toggle", default: false, help: "Require options delta skew to agree with the side." },
      { key: "useLiquidations", label: "Liquidation Confirm", kind: "toggle", default: false, help: "Require liquidation-cluster bias to agree with the side." },
    ],
  },

  decide(inputs: StrategyInputs, params: StrategyParams): SniperDecision {
    if (inputs.phase === "STOPPING") {
      return inputs.openOrder
        ? { action: "CANCEL", side: null, price: null, reason: "T-2s lockout", tif: null, expireAtMs: null }
        : { action: "HOLD", side: null, price: null, reason: "T-2s lockout", tif: null, expireAtMs: null }
    }
    if (inputs.hasPosition) return { action: "HOLD", side: null, price: null, reason: "position filled, riding", tif: null, expireAtMs: null }
    if (inputs.phase === "WAITING" || inputs.phase === "OFFLINE") {
      return inputs.openOrder
        ? { action: "CANCEL", side: null, price: null, reason: "outside window", tif: null, expireAtMs: null }
        : { action: "HOLD", side: null, price: null, reason: "awaiting sniping window", tif: null, expireAtMs: null }
    }
    if (inputs.spot === null || inputs.strike === null) return { action: "HOLD", side: null, price: null, reason: "awaiting spot/strike", tif: null, expireAtMs: null }

    const side = directionWithDriftGuard(inputs.spot, inputs.strike, inputs.cfg.driftPaddingUsd)
    if (!side) return { action: "HOLD", side: null, price: null, reason: "drift guard holding", tif: null, expireAtMs: null }

    // ---- Wall-ratio gate (requires a live book stream) ----
    const book = inputs.book
    if (book?.bidWallVolume == null || book?.askWallVolume == null) {
      return { action: "HOLD", side, price: null, reason: "awaiting book-depth stream for wall ratio", tif: null, expireAtMs: null }
    }
    const wall = side === "UP" ? book.bidWallVolume : book.askWallVolume
    const opposite = side === "UP" ? book.askWallVolume : book.bidWallVolume
    const ratio = opposite > 0 ? wall / opposite : Infinity
    if (ratio < Number(params.wallRatio ?? 2)) {
      return { action: "HOLD", side, price: null, reason: `wall ratio ${ratio.toFixed(2)}x below ${Number(params.wallRatio ?? 2)}x gate`, tif: null, expireAtMs: null }
    }

    // ---- External alpha cross-validation ----
    const alpha = inputs.alpha
    const confirm = (enabled: boolean, agrees: boolean | null) => !enabled || agrees === true
    const fundingAgrees = alpha?.fundingPremium != null ? (side === "UP" ? alpha.fundingPremium > 0 : alpha.fundingPremium < 0) : null
    const skewAgrees = alpha?.deltaSkew != null ? (side === "UP" ? alpha.deltaSkew > 0 : alpha.deltaSkew < 0) : null
    const liqAgrees = alpha?.liquidationClusterBias != null ? alpha.liquidationClusterBias === side : null

    if (!confirm(Boolean(params.useFunding), fundingAgrees)) return { action: "HOLD", side, price: null, reason: "funding premium vetoes side", tif: null, expireAtMs: null }
    if (!confirm(Boolean(params.useDeltaSkew), skewAgrees)) return { action: "HOLD", side, price: null, reason: "delta skew vetoes side", tif: null, expireAtMs: null }
    if (!confirm(Boolean(params.useLiquidations), liqAgrees)) return { action: "HOLD", side, price: null, reason: "liquidation bias vetoes side", tif: null, expireAtMs: null }

    const band = bandForPhase(inputs.phase, inputs.cfg)
    if (!band) return { action: "HOLD", side: null, price: null, reason: "no band for phase", tif: null, expireAtMs: null }
    const price = targetBid(inputs.fairFor(side), band, inputs.cfg.priceFloor, inputs.cfg.priceCeil)
    if (price === null) return { action: "HOLD", side, price: null, reason: "price outside range constraint", tif: null, expireAtMs: null }

    if (!inputs.openOrder) {
      return { action: "QUOTE", side, price, reason: `high-conviction ${side} @ $${price.toFixed(2)} (wall ${ratio.toFixed(2)}x)`, tif: inputs.cfg.tif, expireAtMs: null }
    }
    if (inputs.openOrder.side !== side || Math.abs(inputs.openOrder.price - price) >= TICK) {
      return { action: "REPRICE", side, price, reason: `alpha reprice → ${side} $${price.toFixed(2)}`, tif: inputs.cfg.tif, expireAtMs: null }
    }
    return { action: "HOLD", side, price, reason: "alpha maker resting", tif: null, expireAtMs: null }
  },
}
