/**
 * INC-004 PR-003 — regression suite for H2/H4/H6/H7.
 * See CHANGELOG entry for design summary.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  nextTraceId,
  resetTraceIdCounterForTests,
} from "@/lib/v2/engine/latency-trace"
import {
  checkRateLimit,
  callerKeyFromRequest,
  resetRateLimitsForTests,
  RATE_LIMITS,
} from "@/lib/v2/engine/rate-limit"
import {
  createSessionToken,
  verifySessionToken,
  bumpSessionEpoch,
  currentSessionEpoch,
  resetSessionEpochForTests,
} from "@/lib/v2/engine/dashboard-auth"

describe("PR-003 H2 — deterministic trace IDs", () => {
  beforeEach(() => resetTraceIdCounterForTests())

  it("emits monotonically increasing IDs with a stable prefix", () => {
    const ids = [nextTraceId("tick"), nextTraceId("tick"), nextTraceId("tick")]
    expect(ids).toEqual(["tick-000001", "tick-000002", "tick-000003"])
  })

  it("is deterministic across resets — replays produce identical IDs", () => {
    const first = [nextTraceId("tick"), nextTraceId("tick")]
    resetTraceIdCounterForTests()
    const second = [nextTraceId("tick"), nextTraceId("tick")]
    expect(first).toEqual(second)
  })

  it("does not use Date.now or Math.random", async () => {
    // Guard against a future refactor accidentally re-introducing them.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/v2/engine/latency-trace.ts", "utf8"),
    )
    // The banned expressions are in a comment explaining WHY they're banned,
    // so we look inside the exported function body for actual usage.
    const fnBody = src.slice(src.indexOf("export function nextTraceId"))
    expect(fnBody).not.toMatch(/Date\.now\s*\(/)
    expect(fnBody).not.toMatch(/Math\.random\s*\(/)
  })
})

describe("PR-003 H4 — mutation-endpoint rate limiter", () => {
  beforeEach(() => {
    resetRateLimitsForTests()
    // The limiter is a no-op under NODE_ENV=test to keep other suites fast;
    // flip that off just for this suite so we actually exercise it.
    process.env.RATE_LIMIT_DISABLED = "0"
    delete (process.env as any).NODE_ENV
  })
  afterEach(() => { process.env.NODE_ENV = "test" })

  it("permits requests up to `max`, then rejects with retry-after", () => {
    const cfg = { bucket: "test.x", max: 3, windowMs: 60_000 }
    const key = "1.2.3.4"
    for (let i = 0; i < 3; i++) expect(checkRateLimit(cfg, key).ok).toBe(true)
    const denied = checkRateLimit(cfg, key)
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterSec).toBeGreaterThan(0)
  })

  it("isolates buckets by caller key so one attacker cannot DoS another operator", () => {
    const cfg = { bucket: "test.iso", max: 2, windowMs: 60_000 }
    expect(checkRateLimit(cfg, "attacker").ok).toBe(true)
    expect(checkRateLimit(cfg, "attacker").ok).toBe(true)
    expect(checkRateLimit(cfg, "attacker").ok).toBe(false)
    // Different key — must still succeed.
    expect(checkRateLimit(cfg, "operator").ok).toBe(true)
  })

  it("extracts a stable caller key from x-forwarded-for", () => {
    const req = new Request("http://x/y", { headers: { "x-forwarded-for": "10.0.0.1, 172.16.0.1" } })
    expect(callerKeyFromRequest(req)).toBe("10.0.0.1")
  })

  it("falls back to 'unknown' — never blank — so header-stripping does not bypass", () => {
    const req = new Request("http://x/y")
    expect(callerKeyFromRequest(req)).toBe("unknown")
  })

  it("exposes conservative defaults consistent with a single-operator UI", () => {
    // Guard against a future PR silently raising these to bypass the limit —
    // any change should be reviewed as a security decision.
    expect(RATE_LIMITS.control.max).toBeLessThanOrEqual(60)
    expect(RATE_LIMITS.database.max).toBeLessThanOrEqual(20)
  })
})

describe("PR-003 H6 — session epoch revokes all outstanding sessions", () => {
  const OLD_PW = process.env.DASHBOARD_PASSWORD
  beforeEach(() => {
    process.env.DASHBOARD_PASSWORD = "test-pw-h6"
    resetSessionEpochForTests(0)
  })
  afterEach(() => {
    if (OLD_PW === undefined) delete process.env.DASHBOARD_PASSWORD
    else process.env.DASHBOARD_PASSWORD = OLD_PW
    resetSessionEpochForTests(0)
  })

  it("a token minted before bump is invalid after bump", async () => {
    const token = await createSessionToken()
    expect(await verifySessionToken(token)).toBe(true)
    const newEpoch = bumpSessionEpoch()
    expect(newEpoch).toBe(1)
    expect(currentSessionEpoch()).toBe(1)
    expect(await verifySessionToken(token)).toBe(false)
  })

  it("a token minted after bump is still valid until the next bump", async () => {
    bumpSessionEpoch()
    const token = await createSessionToken()
    expect(await verifySessionToken(token)).toBe(true)
    bumpSessionEpoch()
    expect(await verifySessionToken(token)).toBe(false)
  })
})

describe("PR-003 H7 — LiveExecutor is statically imported", () => {
  it("engine.ts and standing-order.ts no longer use require() for LiveExecutor", async () => {
    const fs = await import("node:fs")
    for (const path of ["lib/v2/engine/engine.ts", "lib/v2/engine/standing-order.ts"]) {
      const src = fs.readFileSync(path, "utf8")
      expect(src).toMatch(/from "\.\/execution\/live"/)
      expect(src).not.toMatch(/require\(["']\.\/execution\/live["']\)/)
    }
  })
})
