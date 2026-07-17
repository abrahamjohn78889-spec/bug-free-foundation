import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    // Dynamic import so a module-level crash in the engine graph (native
    // bindings, env parsing, db init) is caught here and reported as a
    // structured error instead of an opaque 500 with an empty body.
    const { getEngine } = await import("@/lib/v2/engine/engine")
    return NextResponse.json(getEngine().snapshot())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[status:v2] engine snapshot failed:", err)
    return NextResponse.json(
      { error: "ENGINE_INIT_FAILED", message },
      { status: 500 },
    )
  }
}
