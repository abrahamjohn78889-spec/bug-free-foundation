// ============================================================================
// CLOB feed stale-token detection & self-heal (production hardening)
// ============================================================================
// Reproduces the VPS symptom: thousands of consecutive HTTP 404s on tokens
// belonging to a resolved / delisted market. The feed must:
//   1. Escalate to STALE after STALE_AFTER_404_COUNT 404s and stop polling.
//   2. Run a periodic recovery probe on RECOVERY_PROBE_INTERVAL_MS cadence.
//   3. Clear stale state the moment the probe (or a rollover) succeeds.
//   4. Expose stale / probe / recovery state through diagnostics().
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ClobPriceFeed } from "@/lib/v2/engine/feeds/clob-price-feed"

const UP = "token-up-aaaa"
const DOWN = "token-down-bbbb"
const UP_NEW = "token-up-cccc"
const DOWN_NEW = "token-down-dddd"

type Mode = "ok" | "404" | "500"
let mode: Mode = "ok"
let fetchCalls = 0

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      fetchCalls++
      const url = String(input)
      if (mode === "404") return new Response("Not Found", { status: 404, statusText: "Not Found" })
      if (mode === "500") return new Response("boom", { status: 500, statusText: "Internal Server Error" })
      if (url.includes("/price")) return Response.json({ price: url.includes("side=BUY") ? "0.55" : "0.53" })
      if (url.includes("/midpoint")) return Response.json({ mid: "0.54" })
      if (url.includes("/last-trade-price")) return Response.json({ price: "0.55", side: "BUY" })
      if (url.includes("/book"))
        return Response.json({ bids: [{ price: "0.53", size: "100" }], asks: [{ price: "0.55", size: "100" }] })
      return Response.json({})
    }),
  )
}

function internals(feed: ClobPriceFeed) {
  return feed as unknown as {
    poll: (force?: boolean) => Promise<void>
    stopped: boolean
    upTokenId: string | null
    downTokenId: string | null
    lastRecoveryProbeMs: number
    staleSinceMs: number
  }
}

const THRESHOLD = Number(process.env.CLOB_STALE_AFTER_404_COUNT ?? 30)

describe("ClobPriceFeed stale-token detection & self-heal", () => {
  let feed: ClobPriceFeed

  beforeEach(() => {
    mode = "ok"
    fetchCalls = 0
    installFetch()
    feed = new ClobPriceFeed()
    const i = internals(feed)
    i.stopped = false
    i.upTokenId = UP
    i.downTokenId = DOWN
  })

  afterEach(() => {
    feed.stop()
    vi.unstubAllGlobals()
  })

  it("does NOT go stale before the 404 threshold is reached", async () => {
    mode = "404"
    for (let n = 0; n < THRESHOLD - 1; n++) await internals(feed).poll()
    const d = feed.diagnostics()
    expect(d.stale).toBe(false)
    expect(d.consecutive404s).toBe(THRESHOLD - 1)
  })

  it("escalates to STALE after threshold 404s and stops normal polling", async () => {
    mode = "404"
    for (let n = 0; n < THRESHOLD; n++) await internals(feed).poll()
    const d = feed.diagnostics()
    expect(d.stale).toBe(true)
    expect(d.consecutive404s).toBeGreaterThanOrEqual(THRESHOLD)
    expect(d.staleTokens).toEqual({ up: UP, down: DOWN })

    // Subsequent non-forced polls must NOT hit the network — the recovery
    // probe cadence gates them out. This is the 7,000-404s-in-7-hours bug.
    const before = fetchCalls
    for (let n = 0; n < 20; n++) await internals(feed).poll()
    expect(fetchCalls).toBe(before)
  })

  it("recovery probe fires after the configured interval and recovers on success", async () => {
    mode = "404"
    for (let n = 0; n < THRESHOLD; n++) await internals(feed).poll()
    expect(feed.diagnostics().stale).toBe(true)

    // Move the recovery-probe clock backwards to make a probe due right now.
    internals(feed).lastRecoveryProbeMs = 0
    mode = "ok"
    await internals(feed).poll()

    const d = feed.diagnostics()
    expect(d.stale).toBe(false)
    expect(d.consecutive404s).toBe(0)
    expect(d.lastRecoveryOkMs).toBeGreaterThan(0)
    expect(feed.fresh).toBe(true)
  })

  it("token replacement (setTokenIds) clears stale state immediately", async () => {
    mode = "404"
    for (let n = 0; n < THRESHOLD; n++) await internals(feed).poll()
    expect(feed.diagnostics().stale).toBe(true)

    // Rollover to a new market's tokens — the feed must forget the stale marker.
    feed.setTokenIds(UP_NEW, DOWN_NEW)
    const d = feed.diagnostics()
    expect(d.stale).toBe(false)
    expect(d.consecutive404s).toBe(0)
    expect(d.staleTokens).toEqual({ up: null, down: null })
    expect(d.upTokenId).toBe(UP_NEW)
    expect(d.downTokenId).toBe(DOWN_NEW)
  })

  it("non-404 failures do not accumulate toward the 404 threshold", async () => {
    mode = "500"
    for (let n = 0; n < THRESHOLD + 5; n++) await internals(feed).poll()
    const d = feed.diagnostics()
    expect(d.stale).toBe(false)
    expect(d.consecutive404s).toBe(0)
    expect(d.consecutiveFailures).toBeGreaterThan(THRESHOLD)
  })

  it("forced poll bypasses the recovery-probe throttle for operator kicks", async () => {
    mode = "404"
    for (let n = 0; n < THRESHOLD; n++) await internals(feed).poll()
    expect(feed.diagnostics().stale).toBe(true)

    // Without force: no network call (throttled).
    const before = fetchCalls
    await internals(feed).poll(false)
    expect(fetchCalls).toBe(before)

    // With force: probe executes immediately.
    await internals(feed).poll(true)
    expect(fetchCalls).toBeGreaterThan(before)
    expect(feed.diagnostics().recoveryAttempts).toBeGreaterThanOrEqual(1)
  })

  it("diagnostics surface every stale/recovery field for the dashboard", () => {
    const d = feed.diagnostics()
    for (const key of [
      "consecutive404s",
      "stale",
      "staleSinceMs",
      "staleTokens",
      "recoveryAttempts",
      "lastRecoveryProbeMs",
      "lastRecoveryOkMs",
      "stale404Threshold",
      "recoveryProbeIntervalMs",
    ] as const) {
      expect(d).toHaveProperty(key)
    }
  })
})
