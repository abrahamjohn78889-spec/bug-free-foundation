import { NextResponse } from "next/server"
import { getLatencyReport, getLatencySamples } from "@/lib/v2/engine/db"
import type { PipelineMode } from "@/lib/v2/engine/types"

export const dynamic = "force-dynamic"

/**
 * Persistent execution-latency metrics for the /report page.
 * Query params:
 *   - mode:   "PAPER_V1" | "LIVE_V2"  (default LIVE_V2)
 *   - window: window in minutes         (default 1440 = 24h)
 *   - limit:  recent samples to return  (default 50, max 500)
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const modeParam = url.searchParams.get("mode")
  const mode: PipelineMode = modeParam === "PAPER_V1" ? "PAPER_V1" : "LIVE_V2"
  const windowMin = Math.max(1, Math.min(60 * 24 * 30, Number(url.searchParams.get("window") ?? 1440)))
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 50)))

  const report = getLatencyReport(mode, windowMin * 60 * 1000)
  const samples = getLatencySamples(mode, limit)
  return NextResponse.json({ report, samples })
}
