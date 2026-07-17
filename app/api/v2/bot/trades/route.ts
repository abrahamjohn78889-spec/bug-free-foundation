import { NextResponse } from "next/server"
import { recentTrades } from "@/lib/v2/engine/db"
import { getEngine } from "@/lib/v2/engine/engine"

export const dynamic = "force-dynamic"

export async function GET() {
  const engine = getEngine()
  return NextResponse.json({ trades: recentTrades(engine.mode, 100) })
}
