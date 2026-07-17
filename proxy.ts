/**
 * ============================================================================
 * DASHBOARD AUTH PROXY (Next.js 16 middleware)
 * ============================================================================
 * Protects every page and every engine API route when DASHBOARD_PASSWORD is
 * set. Unauthenticated browsers are redirected to /login; unauthenticated
 * API calls receive 401 JSON (no redirect, so fetch() callers fail cleanly).
 *
 * Exemptions:
 *  • /login + /api/auth/*  — the auth flow itself
 *  • /api/v2/bot/health    — read-only liveness probe for uptime monitors
 *    (contains no secrets; exposing health checks unauthenticated is the
 *    standard pattern so external monitors don't need session handling)
 *
 * CSRF: sessions ride an HttpOnly SameSite=Lax cookie, so cross-site POSTs
 * never carry the session. Additionally, mutating API requests must satisfy
 * a same-origin check (Sec-Fetch-Site / Origin) below.
 * ============================================================================
 */
import { NextResponse, type NextRequest } from "next/server"
import { dashboardAuthEnabled, verifySessionToken, SESSION_COOKIE } from "@/lib/v2/engine/dashboard-auth"

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/logout", "/api/v2/bot/health"]

export default async function proxy(req: NextRequest) {
  if (!dashboardAuthEnabled()) return NextResponse.next()

  const { pathname } = req.nextUrl
  if (PUBLIC_PATHS.some((p) => pathname === p)) return NextResponse.next()

  const token = req.cookies.get(SESSION_COOKIE)?.value
  const authed = await verifySessionToken(token)

  if (!authed) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ ok: false, message: "Unauthorized — log in at /login" }, { status: 401 })
    }
    const login = req.nextUrl.clone()
    login.pathname = "/login"
    login.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : ""
    return NextResponse.redirect(login)
  }

  // CSRF hard-stop for authenticated mutating API calls: reject requests a
  // browser marks as cross-site. (SameSite=Lax already prevents the cookie
  // from being sent cross-site; this is defense in depth.)
  if (pathname.startsWith("/api/") && req.method !== "GET" && req.method !== "HEAD") {
    const secFetchSite = req.headers.get("sec-fetch-site")
    if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
      return NextResponse.json({ ok: false, message: "Cross-site request rejected" }, { status: 403 })
    }
    const origin = req.headers.get("origin")
    if (origin) {
      const reqHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host")
      try {
        if (new URL(origin).host !== reqHost) {
          return NextResponse.json({ ok: false, message: "Origin mismatch — request rejected" }, { status: 403 })
        }
      } catch {
        return NextResponse.json({ ok: false, message: "Invalid Origin header" }, { status: 403 })
      }
    }
  }

  return NextResponse.next()
}

export const config = {
  // Protect everything except Next.js internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)"],
}
