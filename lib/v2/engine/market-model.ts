// ------------------------------------------------------------
// Token pricing model for the 5-minute BTC Up/Down contract.
//
// In PAPER_V1 this models the matching engine's fair value for
// the UP token from the live spot tape: a logistic transform of
// the distance between spot and strike, normalized by remaining
// time volatility. Near expiry the curve sharpens toward 0/1,
// which reproduces the $0.90-$0.99 late-window behavior the
// sniper targets.
// ------------------------------------------------------------

/** Per-sqrt-second BTC noise assumption used by the paper model (USD). */
const VOL_USD_PER_SQRT_SEC = 9

export function modelUpProbability(spot: number, strike: number, msRemaining: number): number {
  const secs = Math.max(msRemaining / 1000, 0.05)
  const sigma = VOL_USD_PER_SQRT_SEC * Math.sqrt(secs)
  const z = (spot - strike) / sigma
  // logistic approximation of the normal CDF
  const p = 1 / (1 + Math.exp(-1.702 * z))
  return Math.min(Math.max(p, 0.001), 0.999)
}

export function tokenPrices(spot: number, strike: number, msRemaining: number): { up: number; down: number } {
  const up = modelUpProbability(spot, strike, msRemaining)
  const round = (v: number) => Math.round(v * 100) / 100
  return { up: round(up), down: round(1 - up) }
}
