import type { TradeSide } from "../types"

// ============================================================
// HANDLER 3.4 — OPEN-EXPOSURE ORPHAN ASSET CLEANER
//
// In two-leg strategies (e.g. Edge 1) Leg 1 may fill while Leg 2
// is rejected, dropped, or times out, leaving an unhedged
// position. This handler detects the orphan and builds the
// immediate market-priced FOK counter-order that flattens the
// lone tokens at the best available price, resetting directional
// exposure back to zero.
// ============================================================

export type LegStatus = "FILLED" | "REJECTED" | "PENDING" | "NONE"

export interface OrphanCounterOrder {
  side: TradeSide
  shares: number
  /** Best available price to cross immediately (bid when selling). */
  price: number
  type: "FOK_MARKET"
  urgency: "CRITICAL"
  reason: string
}

/** Detect whether Leg 1 filled but Leg 2 failed, leaving an orphan. */
export function detectOrphan(leg1: LegStatus, leg2: LegStatus): boolean {
  return leg1 === "FILLED" && (leg2 === "REJECTED" || leg2 === "NONE")
}

/**
 * Build the counter-order that liquidates an orphaned leg.
 * @param filledSide the side that filled and now needs flattening.
 * @param bestOpposite best available price on the opposite side of the book.
 */
export function buildOrphanCounter(filledSide: TradeSide, shares: number, bestOpposite: number): OrphanCounterOrder {
  const side: TradeSide = filledSide === "UP" ? "DOWN" : "UP"
  return {
    side,
    shares,
    price: Math.round(bestOpposite * 100) / 100,
    type: "FOK_MARKET",
    urgency: "CRITICAL",
    reason: `orphan recovery: flattening ${shares} ${filledSide} shares via ${side} FOK @ $${bestOpposite.toFixed(2)}`,
  }
}
