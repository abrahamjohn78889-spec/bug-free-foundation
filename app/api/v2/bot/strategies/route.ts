import { NextResponse } from "next/server"
import { allStrategyMeta } from "@/lib/v2/engine/strategy-registry/registry"

export const dynamic = "force-dynamic"

/**
 * Exposes the strategy registry metadata (edges + tunable param
 * schemas) to the client so the Tab 2 configurator renders itself
 * from the single server-side source of truth.
 */
export function GET() {
  return NextResponse.json({ strategies: allStrategyMeta() })
}
