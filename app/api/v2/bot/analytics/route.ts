import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const [{ getEngine }, { computeAnalytics }] = await Promise.all([
      import("@/lib/v2/engine/engine"),
      import("@/lib/v2/engine/analytics"),
    ])
    return NextResponse.json(computeAnalytics(getEngine().mode))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: "ANALYTICS_FAILED", message }, { status: 500 })
  }
}
