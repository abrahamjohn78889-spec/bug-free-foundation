// ============================================================
// HANDLER 3.2 — UNDER-100MS ASYNCHRONOUS CANCEL/REPLACE PIPELINE
//
// The 2026 rules removed the 500ms taker buffer, so a resting
// maker is exposed to adverse selection. When the spot tape
// signals a reversal against an open quote, the engine must pull
// and re-place the order inside the latency budget. This module
// classifies whether a cancel/replace round-trip stayed within
// budget and records the latency for the metrics dashboard.
// ============================================================

export interface LatencyClassification {
  latencyMs: number
  withinBudget: boolean
  reason: string
}

export function classifyCancelReplace(latencyMs: number, budgetMs: number): LatencyClassification {
  const withinBudget = latencyMs <= budgetMs
  return {
    latencyMs,
    withinBudget,
    reason: withinBudget
      ? `cancel/replace in ${latencyMs}ms (≤ ${budgetMs}ms budget)`
      : `cancel/replace ${latencyMs}ms OVER the ${budgetMs}ms budget — adverse-selection risk`,
  }
}

/**
 * Should an open quote be pulled? True when the freshly-computed
 * direction disagrees with the resting order's side (a reversal),
 * or the target price has moved by at least one tick.
 */
export function shouldCancelReplace(
  openSide: "UP" | "DOWN",
  openPrice: number,
  desiredSide: "UP" | "DOWN",
  desiredPrice: number,
  tick = 0.01,
): boolean {
  if (openSide !== desiredSide) return true
  return Math.abs(openPrice - desiredPrice) >= tick
}
