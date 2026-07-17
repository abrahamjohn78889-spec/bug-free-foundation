// ============================================================================
// WATCHDOG TESTS — zombie-socket detection and stale-quote recovery
// ============================================================================
// Uses vitest fake timers to drive the 30s check loop deterministically and
// mocked feed deps to simulate each failure mode the watchdog must repair.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Watchdog } from "@/lib/v2/engine/watchdog"
import type { ClobPriceFeed } from "@/lib/v2/engine/feeds/clob-price-feed"
import type { OrderEventListener } from "@/lib/v2/engine/feeds/order-events"

interface FeedState {
  connected: boolean
  lastMessageAtMs: number
  assetIds: string[]
  upTokenId: string | null
  downTokenId: string | null
  lastSuccessMs: number
}

function makeDeps(feed: Partial<FeedState> = {}, user: Partial<{ hasScope: boolean; connected: boolean; lastFrameAgeMs: number }> = {}) {
  const state: FeedState = {
    connected: true,
    lastMessageAtMs: Date.now(),
    assetIds: ["tok-up", "tok-down"],
    upTokenId: "tok-up",
    downTokenId: "tok-down",
    lastSuccessMs: Date.now(),
    ...feed,
  }
  const calls = { wsReconnects: [] as string[], polls: 0, userReconnects: [] as string[] }
  const clobPriceFeed = {
    wsDiagnostics: () => ({
      connected: state.connected,
      lastMessageAtMs: state.lastMessageAtMs,
      assetIds: state.assetIds,
    }),
    diagnostics: () => ({
      upTokenId: state.upTokenId,
      downTokenId: state.downTokenId,
      lastSuccessMs: state.lastSuccessMs,
      consecutiveFailures: 0,
      lastFailReason: "",
    }),
    forceWsReconnect: (reason: string) => {
      calls.wsReconnects.push(reason)
      // A real reconnect delivers fresh frames — model that so repeated
      // checks don't re-fire unless staleness recurs.
      state.lastMessageAtMs = Date.now()
    },
    pollNow: () => {
      calls.polls++
      state.lastSuccessMs = Date.now()
    },
  } as unknown as ClobPriceFeed
  const orderEvents = {
    hasScope: user.hasScope ?? false,
    connected: user.connected ?? false,
    lastFrameAgeMs: user.lastFrameAgeMs ?? 0,
    forceReconnect: (reason: string) => calls.userReconnects.push(reason),
  } as unknown as OrderEventListener
  return { state, calls, clobPriceFeed, orderEvents }
}

describe("Watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function startWatchdog(deps: ReturnType<typeof makeDeps>, tracking = true) {
    const wd = new Watchdog({
      clobPriceFeed: deps.clobPriceFeed,
      getOrderEvents: () => deps.orderEvents,
      isTrackingMarket: () => tracking,
    })
    wd.start()
    return wd
  }

  it("does nothing when the market WS is healthy", () => {
    const deps = makeDeps()
    const wd = startWatchdog(deps)
    vi.advanceTimersByTime(35_000)
    expect(deps.calls.wsReconnects).toEqual([])
    expect(wd.snapshot().checksRun).toBe(1)
    wd.stop()
  })

  it("detects and repairs a ZOMBIE market WS (open but silent > 90s)", () => {
    const deps = makeDeps({ lastMessageAtMs: Date.now() - 120_000 })
    const wd = startWatchdog(deps)
    vi.advanceTimersByTime(31_000)
    expect(deps.calls.wsReconnects.length).toBe(1)
    expect(deps.calls.wsReconnects[0]).toContain("zombie")
    expect(wd.snapshot().marketWsReconnects).toBe(1)
    wd.stop()
  })

  it("leaves CLOSED sockets to the reconnect-on-close path (no double repair)", () => {
    const deps = makeDeps({ connected: false, lastMessageAtMs: Date.now() - 300_000 })
    const wd = startWatchdog(deps)
    vi.advanceTimersByTime(31_000)
    expect(deps.calls.wsReconnects).toEqual([])
    wd.stop()
  })

  it("ignores WS staleness when no market is being tracked", () => {
    const deps = makeDeps({ lastMessageAtMs: Date.now() - 300_000 })
    const wd = startWatchdog(deps, false)
    vi.advanceTimersByTime(31_000)
    expect(deps.calls.wsReconnects).toEqual([])
    wd.stop()
  })

  it("rate-limits repeated market WS repairs (no reconnect storm on dead network)", () => {
    const deps = makeDeps({ lastMessageAtMs: Date.now() - 120_000 })
    // Make the reconnect NOT restore freshness — a truly dead network.
    ;(deps.clobPriceFeed as unknown as { forceWsReconnect: (r: string) => void }).forceWsReconnect = (r: string) => {
      deps.calls.wsReconnects.push(r)
    }
    const wd = startWatchdog(deps)
    // 3 checks in 90s: only the first may fire a ZOMBIE repair (rate limit =
    // WS_STALE_MS 90s). The separate stale-quote path may also reconnect —
    // count zombie repairs only.
    vi.advanceTimersByTime(31_000)
    vi.advanceTimersByTime(30_000)
    vi.advanceTimersByTime(30_000)
    const zombieRepairs = deps.calls.wsReconnects.filter((r) => r.includes("zombie"))
    expect(zombieRepairs.length).toBe(1)
    expect(wd.snapshot().marketWsReconnects).toBe(1)
    wd.stop()
  })

  it("detects and repairs a ZOMBIE user WS (open but no frames > 60s)", () => {
    const deps = makeDeps({}, { hasScope: true, connected: true, lastFrameAgeMs: 90_000 })
    const wd = startWatchdog(deps)
    vi.advanceTimersByTime(31_000)
    expect(deps.calls.userReconnects.length).toBe(1)
    expect(wd.snapshot().userWsReconnects).toBe(1)
    wd.stop()
  })

  it("recovers stale quotes with WS reconnect + immediate poll", () => {
    const deps = makeDeps({ lastSuccessMs: Date.now() - 60_000 })
    const wd = startWatchdog(deps)
    vi.advanceTimersByTime(31_000)
    expect(deps.calls.polls).toBe(1)
    expect(wd.snapshot().staleQuoteRecoveries).toBe(1)
    wd.stop()
  })

  it("never crashes the process when a dependency throws (chaos: unexpected exception)", () => {
    const deps = makeDeps()
    ;(deps.clobPriceFeed as unknown as { wsDiagnostics: () => never }).wsDiagnostics = () => {
      throw new Error("simulated feed explosion")
    }
    const wd = startWatchdog(deps)
    expect(() => vi.advanceTimersByTime(31_000)).not.toThrow()
    expect(wd.snapshot().checksRun).toBe(1)
    wd.stop()
  })

  it("start() is idempotent — no duplicate timers", () => {
    const deps = makeDeps({ lastMessageAtMs: Date.now() - 120_000 })
    const wd = startWatchdog(deps)
    wd.start() // second start must be a no-op
    vi.advanceTimersByTime(31_000)
    // If a duplicate timer existed, two checks would run.
    expect(wd.snapshot().checksRun).toBe(1)
    wd.stop()
  })
})
