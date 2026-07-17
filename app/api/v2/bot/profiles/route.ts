import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Strategy Profiles API.
 *
 * GET  → list profiles + active profile name, or ?compare=A&compare_b=B for
 *        a read-only A/B comparison.
 * POST → mutations (create/save/rename/duplicate/delete/load/set_notes).
 *        Double-guarded: session middleware + BOT_CONTROL_TOKEN.
 *
 * Loading a profile NEVER starts the engine.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const a = url.searchParams.get("compare")
    const b = url.searchParams.get("compare_b")
    if (a && b) {
      const { compareProfiles } = await import("@/lib/v2/engine/comparison")
      return NextResponse.json(compareProfiles(a, b))
    }
    const { listProfiles, getActiveProfileName } = await import("@/lib/v2/engine/strategy-profiles")
    return NextResponse.json({ profiles: listProfiles(), activeProfile: getActiveProfileName() })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

interface ProfilesBody {
  action?: "create" | "save" | "rename" | "duplicate" | "delete" | "load" | "set_notes"
  name?: string
  newName?: string
  notes?: string
}

export async function POST(req: Request) {
  try {
    const { checkControlAuth } = await import("@/lib/v2/engine/api-auth")
    const auth = checkControlAuth(req)
    if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: 401 })

    const body = (await req.json().catch(() => ({}))) as ProfilesBody
    const name = typeof body.name === "string" ? body.name : ""
    if (!body.action) return NextResponse.json({ ok: false, message: "action required" }, { status: 400 })

    const profiles = await import("@/lib/v2/engine/strategy-profiles")
    const { getEngine } = await import("@/lib/v2/engine/engine")

    switch (body.action) {
      case "create": {
        // Snapshot the CURRENT dashboard configuration into a new named profile.
        const config = profiles.captureCurrentConfig(getEngine())
        const p = profiles.createProfile(name, config, body.notes ?? "")
        return NextResponse.json({ ok: true, message: `Profile "${p.name}" created from current configuration.`, profile: p })
      }
      case "save": {
        // Overwrite an existing profile with the current configuration.
        const config = profiles.captureCurrentConfig(getEngine())
        const p = profiles.saveProfileConfig(name, config, body.notes)
        return NextResponse.json({ ok: true, message: `Profile "${p.name}" updated with current configuration.`, profile: p })
      }
      case "rename": {
        if (typeof body.newName !== "string") return NextResponse.json({ ok: false, message: "newName required" }, { status: 400 })
        const p = profiles.renameProfile(name, body.newName)
        return NextResponse.json({ ok: true, message: `Renamed to "${p.name}".`, profile: p })
      }
      case "duplicate": {
        if (typeof body.newName !== "string") return NextResponse.json({ ok: false, message: "newName required" }, { status: 400 })
        const p = profiles.duplicateProfile(name, body.newName)
        return NextResponse.json({ ok: true, message: `Duplicated "${name}" → "${p.name}".`, profile: p })
      }
      case "delete": {
        profiles.deleteProfile(name)
        return NextResponse.json({ ok: true, message: `Profile "${name}" deleted.` })
      }
      case "load": {
        const result = profiles.loadProfile(getEngine(), name)
        return NextResponse.json(result, { status: result.ok ? 200 : 400 })
      }
      case "set_notes": {
        const p = profiles.getProfile(name)
        if (!p) return NextResponse.json({ ok: false, message: `Profile "${name}" not found` }, { status: 404 })
        const updated = profiles.saveProfileConfig(name, p.config, body.notes ?? "")
        return NextResponse.json({ ok: true, message: "Notes updated.", profile: updated })
      }
      default:
        return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 })
    }
  } catch (err) {
    return NextResponse.json({ ok: false, message: (err as Error).message }, { status: 400 })
  }
}
