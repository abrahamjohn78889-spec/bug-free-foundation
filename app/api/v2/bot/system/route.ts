import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const [{ systemInfo }, { getEngine }] = await Promise.all([
      import("@/lib/v2/engine/system-monitor"),
      import("@/lib/v2/engine/engine"),
    ])
    const engine = getEngine()
    const snap = engine.snapshot()
    const info = await systemInfo()
    return NextResponse.json({
      ...info,
      engine: {
        mode: snap.mode,
        running: snap.running,
        clockOffsetMs: snap.clockOffsetMs,
        watchdog: snap.watchdog ?? null,
        feed: snap.clobDiagnostics ?? null,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: "SYSTEM_INFO_FAILED", message }, { status: 500 })
  }
}
