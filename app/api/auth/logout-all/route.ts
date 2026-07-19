import { NextResponse } from "next/server"
import { bumpSessionEpoch, clearSessionCookieHeader } from "@/lib/v2/engine/dashboard-auth"
import { checkControlAuth } from "@/lib/v2/engine/api-auth"
import { checkRateLimit, callerKeyFromRequest, RATE_LIMITS } from "@/lib/v2/engine/rate-limit"

export const runtime = "nodejs"

/**
 * PR-003 H6 — sign out every browser tab on every device by bumping the
 * server-side session epoch. Every existing HMAC-signed cookie is derived
 * from the old epoch and fails verify() immediately.
 *
 * Guarded by BOT_CONTROL_TOKEN so a hijacked *dashboard* cookie cannot
 * revoke sessions on its own — the caller must present the out-of-band
 * operator secret. Rate-limited to blunt token-based abuse.
 */
export async function POST(req: Request) {
  const rl = checkRateLimit(RATE_LIMITS.control, callerKeyFromRequest(req))
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, message: `Rate limit exceeded — retry in ${rl.retryAfterSec}s` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    )
  }
  const auth = checkControlAuth(req)
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: 401 })
  const epoch = bumpSessionEpoch()
  const res = NextResponse.json({ ok: true, message: "All sessions invalidated", epoch })
  res.headers.set("Set-Cookie", clearSessionCookieHeader())
  return res
}
