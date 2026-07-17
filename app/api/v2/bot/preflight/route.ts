import { NextResponse } from "next/server"
import { getEngine } from "@/lib/v2/engine/engine"
import { runPreflight } from "@/lib/v2/engine/preflight"

export const dynamic = "force-dynamic"

export async function GET() {
  const report = await runPreflight(getEngine().mode)
  return NextResponse.json(report)
}
