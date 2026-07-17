import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/**
 * GET  /api/v2/bot/notifications → current category toggles + configured flag
 * POST /api/v2/bot/notifications { prefs: { orders: false, ... } } → update
 * POST { action: "test" } → send a test notification
 * Auth: dashboard session middleware (proxy.ts) gates all /api/v2 routes.
 */
export async function GET() {
  try {
    const { getNotifyPrefs, NOTIFY_CATEGORIES } = await import("@/lib/v2/engine/notifier")
    const { env } = await import("@/lib/v2/engine/config")
    return NextResponse.json({
      prefs: getNotifyPrefs(),
      categories: NOTIFY_CATEGORIES,
      configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: "NOTIFY_PREFS_FAILED", message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const { checkControlAuth } = await import("@/lib/v2/engine/api-auth")
    const auth = checkControlAuth(req)
    if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED", message: auth.message }, { status: 401 })
    const { getNotifyPrefs, setNotifyPrefs, notify } = await import("@/lib/v2/engine/notifier")
    const body = (await req.json().catch(() => ({}))) as {
      action?: string
      prefs?: Record<string, boolean>
    }
    if (body.action === "test") {
      notify("lifecycle", "TEST NOTIFICATION", "Dashboard connectivity check — notifications are working")
      return NextResponse.json({ ok: true, prefs: getNotifyPrefs() })
    }
    if (body.prefs && typeof body.prefs === "object") {
      return NextResponse.json({ ok: true, prefs: setNotifyPrefs(body.prefs) })
    }
    return NextResponse.json({ error: "UNKNOWN_ACTION" }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: "NOTIFY_UPDATE_FAILED", message }, { status: 500 })
  }
}
