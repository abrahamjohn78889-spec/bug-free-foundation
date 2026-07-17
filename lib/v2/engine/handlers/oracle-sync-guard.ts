import type { TradeSide } from "../types"

// ============================================================
// HANDLER 3.1 — MANDATORY ORACLE SYNC DRIFT GUARD
//
// Before any edge routes a maker order, the live BTC spot tape
// must have cleared the candle strike by a configurable padding
// margin in the direction we intend to buy. If spot is hovering
// near the strike or reversing across it, no direction is
// returned and the caller must abort — this is what stops the
// bot buying into a coin-flip that can whip back over the line.
// ============================================================

export interface OracleGuardResult {
  /** Direction cleared to trade, or null if the guard is holding. */
  side: TradeSide | null
  cleared: boolean
  /** Signed distance of spot from strike, in USD (positive = above). */
  distanceUsd: number
  reason: string
}

const STALE_MS = 10_000

/**
 * Evaluate the drift guard for the current candle.
 * @param spotTsMs timestamp of the spot tick, to reject a frozen tape.
 */
export function evaluateOracleGuard(
  spot: number | null,
  strike: number | null,
  paddingUsd: number,
  spotTsMs: number | null = null,
  nowMs: number = Date.now(),
): OracleGuardResult {
  if (spot === null || strike === null) {
    return { side: null, cleared: false, distanceUsd: 0, reason: "awaiting spot/strike data" }
  }
  if (spotTsMs !== null && nowMs - spotTsMs > STALE_MS) {
    return { side: null, cleared: false, distanceUsd: 0, reason: "spot tape stale — guard holding" }
  }
  const distanceUsd = Math.round((spot - strike) * 100) / 100
  if (spot >= strike + paddingUsd) {
    return { side: "UP", cleared: true, distanceUsd, reason: `spot cleared strike by +$${distanceUsd.toFixed(2)} (UP)` }
  }
  if (spot <= strike - paddingUsd) {
    return { side: "DOWN", cleared: true, distanceUsd, reason: `spot cleared strike by $${distanceUsd.toFixed(2)} (DOWN)` }
  }
  return {
    side: null,
    cleared: false,
    distanceUsd,
    reason: `drift guard: spot within $${paddingUsd} padding of strike (Δ $${distanceUsd.toFixed(2)})`,
  }
}
