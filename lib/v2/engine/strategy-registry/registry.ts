import { edge1 } from "./strategies/edge1-40-50-sequential"
import { edge2 } from "./strategies/edge2-penny-continuum"
import { edge3 } from "./strategies/edge3-passive-trapping"
import { edge4 } from "./strategies/edge4-context-aware"
import { edge5 } from "./strategies/edge5-meta-cognitive"
import { edge6 } from "./strategies/edge6-book-depth-alpha"
import type { Strategy, StrategyId, StrategyMeta, StrategyParams } from "./types"

// ============================================================
// Strategy Registry — single source of truth for the 6 edges.
// The engine and the UI both read from here so a new edge is
// added in exactly one place.
// ============================================================

const REGISTRY: Record<StrategyId, Strategy> = {
  edge1,
  edge2,
  edge3,
  edge4,
  edge5,
  edge6,
}

/** Ordered for display — Edge 5 (primary) leads. */
export const STRATEGY_ORDER: StrategyId[] = ["edge5", "edge1", "edge2", "edge3", "edge4", "edge6"]

export function getStrategy(id: StrategyId): Strategy {
  return REGISTRY[id] ?? REGISTRY.edge5
}

export function allStrategyMeta(): StrategyMeta[] {
  return STRATEGY_ORDER.map((id) => REGISTRY[id].meta)
}

export function isStrategyId(v: unknown): v is StrategyId {
  return typeof v === "string" && v in REGISTRY
}

/** Build the default params map for a strategy from its meta schema. */
export function defaultParamsFor(id: StrategyId): StrategyParams {
  const params: StrategyParams = {}
  for (const p of REGISTRY[id].meta.params) params[p.key] = p.default
  return params
}

/** Default params for every strategy, keyed by id. */
export function allDefaultParams(): Record<StrategyId, StrategyParams> {
  const out = {} as Record<StrategyId, StrategyParams>
  for (const id of STRATEGY_ORDER) out[id] = defaultParamsFor(id)
  return out
}
