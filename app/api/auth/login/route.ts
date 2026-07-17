import { NextResponse } from "next/server"
import {
  checkCredentials,
  createSessionToken,
  dashboardAuthEnabled,
  requestIsHttps,
  sessionCookieHeader,
} from "@/lib/v2/engine/dashboard-auth"

export const runtime = "nodejs"

/** Simple in-memory brute-force throttle: 5 failures → 30s lockout per process. */
let failCount = 0
let lockUntilMs = 0

export async function POST(req: Request) {
  if (!dashboardAuthEnabled()) {
    return NextResponse.json(
      { ok: false, message: "Dashboard auth is not configured (DASHBOARD_PASSWORD is unset)" },
      { status: 400 },
    )
  }

  if (Date.now() < lockUntilMs) {
    return NextResponse.json(
      { ok: false, message: "Too many failed attempts — try again in 30 seconds" },
      { status: 429 },
    )
  }

  let body: { username?: unknown; password?: unknown }
  try {
    body = (await req.json()) as { username?: unknown; password?: unknown }
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON" }, { status: 400 })
  }

  if (typeof body.username !== "string" || body.username.length === 0 || body.username.length > 128) {
    return NextResponse.json({ ok: false, message: "Username required" }, { status: 400 })
  }
  if (typeof body.password !== "string" || body.password.length === 0 || body.password.length > 256) {
    return NextResponse.json({ ok: false, message: "Password required" }, { status: 400 })
  }

  // Single generic failure message: never reveal WHICH field was wrong.
  const valid = await checkCredentials(body.username, body.password)
  if (!valid) {
    failCount++
    if (failCount >= 5) {
      lockUntilMs = Date.now() + 30_000
      failCount = 0
    }
    return NextResponse.json({ ok: false, message: "Incorrect username or password" }, { status: 401 })
  }

  failCount = 0
  const token = await createSessionToken()
  const res = NextResponse.json({ ok: true, message: "Logged in" })
  res.headers.set("Set-Cookie", sessionCookieHeader(token, requestIsHttps(req)))
  return res
}
