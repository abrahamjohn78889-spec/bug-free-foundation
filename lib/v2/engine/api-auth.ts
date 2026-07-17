import { timingSafeEqual } from "node:crypto"

/**
 * Opt-in shared-secret auth for mutating bot API routes.
 *
 * Set BOT_CONTROL_TOKEN in .env to require callers to send either:
 *   Authorization: Bearer <token>     or     x-bot-token: <token>
 *
 * When BOT_CONTROL_TOKEN is unset the guard is a no-op (backwards compatible
 * for a localhost-only VPS setup behind a firewall). If the dashboard is ever
 * exposed on a public port, setting the token makes engine control —
 * start/stop, kill switch, risk limits, placing real-money standing orders —
 * require the secret. Comparison is constant-time to prevent timing attacks.
 */
export function checkControlAuth(req: Request): { ok: true } | { ok: false; message: string } {
  const required = process.env.BOT_CONTROL_TOKEN
  if (!required || required.length === 0) return { ok: true }

  const header = req.headers.get("authorization") ?? ""
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : ""
  const alt = req.headers.get("x-bot-token") ?? ""
  const supplied = bearer || alt

  if (supplied.length > 0 && supplied.length === required.length) {
    try {
      if (timingSafeEqual(Buffer.from(supplied), Buffer.from(required))) return { ok: true }
    } catch {
      /* length mismatch race — fall through to reject */
    }
  }
  return { ok: false, message: "Unauthorized: missing or invalid bot control token" }
}
