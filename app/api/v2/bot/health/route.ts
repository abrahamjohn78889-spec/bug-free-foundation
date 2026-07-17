import { NextResponse } from "next/server"
import { computeHealth } from "@/lib/v2/engine/health"

export const dynamic = "force-dynamic"

/**
 * Health endpoint for external monitoring (uptime checks, PM2 health probes,
 * alerting). Returns HTTP 200 when every critical subsystem is healthy and
 * HTTP 503 with per-subsystem detail when anything is degraded.
 *
 * All check logic lives in lib/v2/engine/health.ts (also consumed by the
 * in-process health monitor that pushes Telegram alerts on transitions).
 */
export async function GET() {
  const report = computeHealth()
  return NextResponse.json(report, { status: report.status === "healthy" ? 200 : 503 })
}
