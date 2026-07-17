// ============================================================
// HANDLER 3.5 — DYNAMIC 5-SHARE PROTOCOL GUARD
//
// Polymarket enforces a hard minimum share count per order.
// Before any submission this validator floors the capital pool
// into whole shares and, if the result falls under the minimum,
// computes the capital top-up required to safely clear it.
// ============================================================

export interface ProtocolValidation {
  ok: boolean
  shares: number
  /** Capital required to clear the minimum (only when scaling is needed). */
  requiredCapital: number
  scaled: boolean
  reason: string
}

export function validateOrderSize(
  capitalPool: number,
  price: number,
  minShares: number,
  maxCapital = Number.POSITIVE_INFINITY,
): ProtocolValidation {
  if (price <= 0) return { ok: false, shares: 0, requiredCapital: 0, scaled: false, reason: "invalid price" }
  if (capitalPool <= 0) return { ok: false, shares: 0, requiredCapital: 0, scaled: false, reason: "empty capital pool" }

  const shares = Math.floor(capitalPool / price)
  if (shares >= minShares) {
    return { ok: true, shares, requiredCapital: 0, scaled: false, reason: `${shares} shares clears ${minShares}-share minimum` }
  }

  // Under the minimum — compute the top-up needed to place exactly minShares.
  const requiredCapital = Math.ceil(minShares * price * 100) / 100
  if (requiredCapital <= maxCapital) {
    return {
      ok: false,
      shares: minShares,
      requiredCapital,
      scaled: true,
      reason: `capital below ${minShares}-share minimum — scale pool to $${requiredCapital.toFixed(2)}`,
    }
  }
  return {
    ok: false,
    shares,
    requiredCapital,
    scaled: false,
    reason: `insufficient capital: need $${requiredCapital.toFixed(2)} for ${minShares} shares @ $${price.toFixed(2)}`,
  }
}
