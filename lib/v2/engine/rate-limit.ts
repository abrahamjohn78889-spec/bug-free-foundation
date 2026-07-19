/**
 * ============================================================================
 * PR-003 H4 — In-process rate limiter for authenticated mutation endpoints.
 * ============================================================================
 *
 * The bot dashboard is intended for a single operator on a single VPS behind
 * the reverse proxy, but every authenticated mutation surface (control API,
 * database maintenance, notification config, profiles) is money-adjacent —
 * a rogue browser tab or a leaked BOT_CONTROL_TOKEN + xhr flood must not be
 * able to drain the rate limits the engine relies on internally, cancel
 * every open order, or wipe the ledger via replay.
 *
 * This is a deliberately small, dependency-free token-bucket keyed by
 * (bucketId, callerKey). It runs entirely in-memory in the Next.js server
 * process — there is no distributed limiter because there is a single
 * process. Per the "no-backend-rate-limiting" workspace note we surface
 * this tradeoff to the operator via OPERATIONS.md; do not treat this as a
 * DDoS shield, only as a "prevent accidental self-DoS and abuse via a
 * single leaked token" guard.
 *
 * Semantics:
 *   • Each bucket has a capacity and a refill window (ms). We track
 *     timestamps of the last N requests and reject once N is reached
 *     inside the window. Sliding-window log — good enough at the request
 *     volumes (< 1 req/s per operator) we see, and easy to reason about.
 *   • Bypass in NODE_ENV=test so unit tests do not become flaky if the
 *     same route gets hammered by parallel test cases.
 *   • Callers should include this in the same code path as auth checks
 *     so a rejected request never touches the engine.
 */

const buckets = new Map<string, number[]>()

export interface RateLimitConfig {
  /** Stable bucket name — usually the route path. */
  bucket: string
  /** Max requests allowed inside `windowMs`. */
  max: number
  /** Sliding window in milliseconds. */
  windowMs: number
}

export interface RateLimitResult {
  ok: boolean
  remaining: number
  resetMs: number
  retryAfterSec: number
}

/**
 * Extract a stable caller key. Prefers the first x-forwarded-for entry so a
 * reverse-proxied deployment can distinguish operators; falls back to
 * "unknown" so an attacker cannot bypass by stripping headers.
 */
export function callerKeyFromRequest(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")
  if (xff && xff.length > 0) return xff.split(",")[0].trim() || "unknown"
  const real = req.headers.get("x-real-ip")
  if (real && real.length > 0) return real
  return "unknown"
}

export function checkRateLimit(cfg: RateLimitConfig, callerKey: string): RateLimitResult {
  // Never rate-limit during automated tests — deterministic replay would
  // otherwise deadlock on parallel vitest invocations of the same route.
  if (process.env.NODE_ENV === "test" || process.env.RATE_LIMIT_DISABLED === "1") {
    return { ok: true, remaining: cfg.max, resetMs: 0, retryAfterSec: 0 }
  }
  const now = Date.now()
  const key = `${cfg.bucket}::${callerKey}`
  const cutoff = now - cfg.windowMs
  const arr = buckets.get(key) ?? []
  // Drop expired timestamps in-place; small array so O(n) is fine.
  const live = arr.filter((t) => t > cutoff)
  if (live.length >= cfg.max) {
    const oldest = live[0]
    const resetMs = oldest + cfg.windowMs - now
    return {
      ok: false,
      remaining: 0,
      resetMs,
      retryAfterSec: Math.max(1, Math.ceil(resetMs / 1000)),
    }
  }
  live.push(now)
  buckets.set(key, live)
  return {
    ok: true,
    remaining: cfg.max - live.length,
    resetMs: cfg.windowMs,
    retryAfterSec: 0,
  }
}

/** Test-only helper — reset every bucket between cases. */
export function resetRateLimitsForTests(): void {
  buckets.clear()
}

/**
 * Default configs. Chosen conservatively: an operator UI does not generate
 * more than a handful of mutations per second. Bumping these requires
 * explicitly justifying that no logged incident was caused by a burst under
 * the new bound.
 */
export const RATE_LIMITS = {
  control:       { bucket: "bot.control",       max: 30, windowMs: 60_000 } as RateLimitConfig,
  database:      { bucket: "bot.database",      max: 10, windowMs: 60_000 } as RateLimitConfig,
  notifications: { bucket: "bot.notifications", max: 20, windowMs: 60_000 } as RateLimitConfig,
  profiles:      { bucket: "bot.profiles",      max: 20, windowMs: 60_000 } as RateLimitConfig,
  loginBurst:    { bucket: "auth.login",        max: 10, windowMs: 60_000 } as RateLimitConfig,
} as const
