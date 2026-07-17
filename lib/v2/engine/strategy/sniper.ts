import { HOLD_MS, P1_OPEN_MS, P2_OPEN_MS, TIF_MS } from "../config"
import { evaluateOracleGuard } from "../handlers/oracle-sync-guard"
import type { EnginePhase, PriceBand, StrategyConfig, TIF, TradeSide } from "../types"

// ------------------------------------------------------------
// Dynamic Cascading Sniper — Time-Decay Target Matrix
//
//  Priority 1  T-20s..T-11s : hunt cheap liquidity  ($0.90-$0.94)
//  Priority 2  T-10s..T-3s  : certainty window      ($0.95-$0.99)
//  Priority 3  T-2s..T-0s   : STOPPING hold state — payloads forbidden
//
// All functions here are pure so the matrix is unit-testable and
// the live/paper pipelines share identical decision logic.
// ------------------------------------------------------------

export function phaseFor(tMinusMs: number, cfg?: StrategyConfig): EnginePhase {
  if (tMinusMs <= HOLD_MS) return "STOPPING"
  if (tMinusMs <= P2_OPEN_MS) return "PRIORITY_2"
  const p1Window = cfg?.p1WindowMs ?? P1_OPEN_MS
  if (p1Window > 0 && tMinusMs <= p1Window) return "PRIORITY_1"
  // If p1WindowMs is 0, time windows are disabled - everything outside STOPPING/P2 is WAITING
  return "WAITING"
}

export function bandForPhase(phase: EnginePhase, cfg: StrategyConfig): PriceBand | null {
  if (phase === "PRIORITY_1") return cfg.p1Band
  if (phase === "PRIORITY_2") return cfg.p2Band
  return null
}

/**
 * Mandatory Oracle Sync Drift Guard.
 * The live spot tape must have cleared the strike by the padding
 * margin in the direction we want to buy. If spot is reversing back
 * over the strike line, no direction is returned and the trade aborts.
 */
export function directionWithDriftGuard(spot: number, strike: number, paddingUsd: number): TradeSide | null {
  // Single source of truth: delegate to the Oracle Sync Drift Guard handler.
  return evaluateOracleGuard(spot, strike, paddingUsd).side
}

export interface SniperDecision {
  action: "HOLD" | "QUOTE" | "REPRICE" | "CANCEL"
  side: TradeSide | null
  price: number | null
  reason: string
  /** TIF to stamp on a new QUOTE or REPRICE order. null for HOLD/CANCEL. */
  tif: TIF | null
  /** Engine-side expiry timestamp (ms). null = GTC. */
  expireAtMs: number | null
}

export interface SniperInputs {
  phase: EnginePhase
  spot: number | null
  strike: number | null
  cfg: StrategyConfig
  /** modeled/observed price of the token on the target side */
  fairFor: (side: TradeSide) => number
  openOrder: { side: TradeSide; price: number; placedAtMs: number } | null
  hasPosition: boolean
}

const TICK = 0.01

/**
 * Choose the maker bid inside the active band, one tick under fair value,
 * then hard-clamp to the absolute [priceFloor, priceCeil] constraints.
 * Returns null if the resulting price would fall outside the allowed range
 * — the caller must treat null as a HOLD (no order placed).
 */
export function targetBid(
  fair: number,
  band: PriceBand,
  priceFloor: number,
  priceCeil: number,
): number | null {
  const raw = Math.min(band.max, fair - TICK)
  const inBand = Math.max(band.min, raw)
  const price = Math.round(inBand * 100) / 100
  // Hard reject if outside the absolute price constraints.
  if (price < priceFloor || price > priceCeil) return null
  return price
}

/** Convenience: build a hold/cancel decision with no TIF attached. */
function hold(reason: string, cancel = false, openOrder?: SniperInputs["openOrder"]): SniperDecision {
  return {
    action: cancel && openOrder ? "CANCEL" : "HOLD",
    side: null,
    price: null,
    reason,
    tif: null,
    expireAtMs: null,
  }
}

export function decide(i: SniperInputs): SniperDecision {
  const { tif, priceFloor, priceCeil } = i.cfg

  // Compute engine-side expiry from TIF once so every branch can use it.
  const tifMs = TIF_MS[tif] ?? null
  const expireAtMs = tifMs !== null ? Date.now() + tifMs : null

  // Priority 3 hold state: drop everything, fire nothing.
  if (i.phase === "STOPPING") {
    return i.openOrder
      ? hold("T-2s hold state: dropping all orders", true, i.openOrder)
      : hold("T-2s hold state")
  }

  if (i.phase === "WAITING" || i.phase === "OFFLINE") {
    return i.openOrder
      ? hold("outside sniping window", true, i.openOrder)
      : hold("waiting for T-20s window")
  }

  if (i.hasPosition) return hold("position filled, riding to expiry")

  if (i.spot === null || i.strike === null) return hold("awaiting spot/strike data")

  const side = directionWithDriftGuard(i.spot, i.strike, i.cfg.driftPaddingUsd)
  if (!side) {
    return i.openOrder
      ? hold("drift guard: spot reversing over strike, aborting", true, i.openOrder)
      : hold("drift guard: no clear direction")
  }

  const band = bandForPhase(i.phase, i.cfg)
  if (!band) return hold("no band for phase")

  const price = targetBid(i.fairFor(side), band, priceFloor, priceCeil)

  // targetBid returns null when the computed price is outside the
  // absolute [priceFloor, priceCeil] constraint — treat as HOLD.
  if (price === null) {
    return i.openOrder
      ? hold(`price-range guard: bid outside $${priceFloor}–$${priceCeil}, cancelling`, true, i.openOrder)
      : hold(`price-range guard: bid outside $${priceFloor}–$${priceCeil}`)
  }

  if (!i.openOrder) {
    return {
      action: "QUOTE",
      side,
      price,
      reason: `${i.phase} quoting ${side} @ $${price.toFixed(2)} [${tif}]`,
      tif,
      expireAtMs,
    }
  }

  // Engine-side TIF expiry: if the resting order has been alive longer
  // than the TIF window, cancel it (CLOB-side expiry handles LIVE_V2,
  // but the paper executor needs the engine to cancel explicitly).
  if (expireAtMs !== null && Date.now() > i.openOrder.placedAtMs + (tifMs ?? Infinity)) {
    return hold(`TIF ${tif} expired — cancelling unfilled order`, true, i.openOrder)
  }

  // Sub-100ms cancel/replace triggers: direction flip or stale level.
  if (i.openOrder.side !== side) {
    return {
      action: "REPRICE",
      side,
      price,
      reason: `reversal detected: flipping ${i.openOrder.side} -> ${side}`,
      tif,
      expireAtMs,
    }
  }
  if (Math.abs(i.openOrder.price - price) >= TICK) {
    return {
      action: "REPRICE",
      side,
      price,
      reason: `repricing ${i.openOrder.price.toFixed(2)} -> ${price.toFixed(2)}`,
      tif,
      expireAtMs,
    }
  }

  return { action: "HOLD", side, price, reason: "resting at target level", tif, expireAtMs }
}
