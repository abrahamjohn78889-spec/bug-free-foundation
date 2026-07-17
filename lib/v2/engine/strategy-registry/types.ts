import type { SniperDecision, SniperInputs } from "../strategy/sniper"
import type { StrategyId, StrategyParams } from "../types"

export type { StrategyId, StrategyParams }

// ============================================================
// Strategy Registry — shared contract for all 6 quant edges.
//
// Every edge is an isolated, self-contained module implementing
// the `Strategy` interface. The engine never imports a concrete
// strategy directly — it asks the registry for the active edge
// and calls `decide()`. This keeps each edge swappable, testable,
// and independently ownable by different engineers.
// ============================================================

/**
 * Extended decision inputs. Superset of the core SniperInputs so
 * every edge shares the same clock/spot/drift context, plus the
 * optional order-book microstructure fields that the depth-aware
 * edges (2, 3, 6) consume when a live book stream is attached.
 * All extra fields default to null so paper mode stays offline-safe.
 */
export interface StrategyInputs extends SniperInputs {
  /** Best bid/ask + wall sizes for the UP/DOWN tokens (live book only). */
  book?: {
    upBid: number | null
    upAsk: number | null
    downBid: number | null
    downAsk: number | null
    /** Total resting bid volume vs. ask volume across the book. */
    bidWallVolume: number | null
    askWallVolume: number | null
  } | null
  /** Trailing spot-volume metrics for volume-confirmation edges. */
  volume?: {
    last30sVolume: number | null
    trailingAvgVolume: number | null
  } | null
  /** External alpha metrics for the high-conviction streamer (edge 6). */
  alpha?: {
    fundingPremium: number | null
    deltaSkew: number | null
    liquidationClusterBias: "UP" | "DOWN" | null
  } | null
}

/** A single tunable parameter surfaced in the Tab 2 configurator. */
export interface StrategyParam {
  key: string
  label: string
  /** numeric | toggle | select */
  kind: "number" | "toggle" | "select"
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: { value: string; label: string }[]
  default: number | boolean | string
  help: string
}

/** UI + descriptive metadata for a strategy edge. */
export interface StrategyMeta {
  id: StrategyId
  code: string
  name: string
  tagline: string
  description: string
  /** true once the edge is fully armed for LIVE_V2 routing. */
  liveReady: boolean
  params: StrategyParam[]
}

export interface Strategy {
  meta: StrategyMeta
  /**
   * Pure decision function. Must never mutate inputs, never touch
   * IO — the engine owns all order routing and persistence.
   */
  decide(inputs: StrategyInputs, params: StrategyParams): SniperDecision
}
