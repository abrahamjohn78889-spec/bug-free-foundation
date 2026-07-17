// ============================================================
// HANDLER 3.3 — CUMULATIVE COMPOUNDING & FRACTIONAL DUST SWEEPER
//
//   Shares = Floor((Balance + DustReserve) / Price)
//
// Contracts trade in whole integer shares, so the fractional
// remainder ("dust") left after flooring is swept into a reserve
// and rolled forward into the next candle's capital pool. This
// module holds the pure math; persistence lives in Bankroll.
// ============================================================

export interface CompoundResult {
  shares: number
  cost: number
  dust: number
  capitalPool: number
}

const round4 = (n: number) => Math.round(n * 10000) / 10000

/** Floor the pool into whole shares and compute the swept dust remainder. */
export function computeCompounding(balance: number, dustReserve: number, price: number, minShares: number): CompoundResult | null {
  const capitalPool = round4(balance + dustReserve)
  if (price <= 0 || capitalPool <= 0) return null
  const shares = Math.floor(capitalPool / price)
  if (shares < minShares) return null
  const cost = round4(shares * price)
  const dust = Math.max(round4(capitalPool - cost), 0)
  return { shares, cost, dust, capitalPool }
}

/**
 * Decide whether the accumulated dust reserve has crossed the
 * auto-sweep threshold and should be rolled back into the pool.
 */
export function shouldSweepDust(dustReserve: number, threshold: number): boolean {
  return dustReserve >= threshold && threshold > 0
}
