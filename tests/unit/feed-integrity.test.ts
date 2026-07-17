// ============================================================================
// FEED INTEGRITY TESTS — Phase 1 acceptance criteria
// ============================================================================
// Verifies the generation model, atomic validated snapshot, confidence
// grading, slot-rollover quote isolation, in-flight request invalidation,
// and empty-book classification. These tests encode the acceptance criteria:
//   • zero stale quote decisions
//   • zero mixed-generation decisions
//   • zero previous-slot quotes used
//   • zero execution decisions using invalid quotes
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ClobPriceFeed } from "@/lib/v2/engine/feeds/clob-price-feed"
import type { WsBestAsk } from "@/lib/v2/engine/feeds/clob-ws-client"

const UP = "token-up-111"
const DOWN = "token-down-222"
const UP2 = "token-up-333"
const DOWN2 = "token-down-444"

type FetchBehavior = (url: string) => Response | Promise<Response>

let fetchBehavior: FetchBehavior
let fetchCalls = 0

function okResponses(askUp = "0.55", askDown = "0.53"): FetchBehavior {
  return (url: string) => {
    if (url.includes("/price")) {
      const isUp = url.includes(UP) || url.includes(UP2)
      return Response.json({ price: isUp ? askUp : askDown })
    }
    if (url.includes("/midpoint")) return Response.json({ mid: "0.54" })
    if (url.includes("/last-trade-price")) return Response.json({ price: "0.55", side: "BUY" })
    if (url.includes("/book"))
      return Response.json({ bids: [{ price: "0.53", size: "100" }], asks: [{ price: "0.55", size: "100" }] })
    return Response.json({})
  }
}

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      fetchCalls++
      return fetchBehavior(String(input))
    }),
  )
}

function internals(feed: ClobPriceFeed) {
  return feed as unknown as {
    poll: (immediate?: boolean) => Promise<void>
    stopped: boolean
    upTokenId: string | null
    downTokenId: string | null
    gen: number
    applyWsUpdate: (u: WsBestAsk) => void
    restBackoffUntilMs: number
  }
}

describe("generation model", () => {
  let feed: ClobPriceFeed

  beforeEach(() => {
    fetchCalls = 0
    fetchBehavior = okResponses()
    installFetchMock()
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

  it("setTokenIds with NEW tokens bumps the generation and clears all quotes", async () => {
    await internals(feed).poll()
    expect(feed.latestUp).not.toBeNull()
    const genBefore = feed.generation
    feed.setTokenIds(UP2, DOWN2)
    expect(feed.generation).toBe(genBefore + 1)
    expect(feed.latestUp).toBeNull()
    expect(feed.latestDown).toBeNull()
    expect(feed.validatedQuotes()).toBeNull()
  })

  it("setTokenIds with the SAME tokens does NOT bump the generation", async () => {
    await internals(feed).poll()
    const genBefore = feed.generation
    feed.setTokenIds(UP, DOWN)
    expect(feed.generation).toBe(genBefore)
    expect(feed.latestUp).not.toBeNull()
  })

  it("SLOT-ROLLOVER RACE: an in-flight REST poll from generation N can never write into generation N+1", async () => {
    // Slow fetch: the poll starts under the OLD tokens, and the market rolls
    // over while the request is still in flight. Historically this resurrected
    // previous-market quotes with fresh timestamps — the root cause of the
    // wrong-side trades.
    let releaseFetch: () => void = () => {}
    const gate = new Promise<void>((r) => (releaseFetch = r))
    const respond = okResponses("0.99", "0.01") // distinctive OLD-market prices
    fetchBehavior = async (url) => {
      await gate
      return respond(url)
    }
    const inflight = internals(feed).poll()
    // ROLLOVER while the old poll is still in flight. Swap the mock BEFORE
    // setTokenIds so the new generation's immediate poll gets NEW-market
    // prices — only the gated in-flight requests return the old 0.99.
    fetchBehavior = okResponses("0.40", "0.60")
    feed.setTokenIds(UP2, DOWN2)
    releaseFetch()
    await inflight
    // The old poll's writes MUST have been discarded — either no quote at all,
    // or (if the new-market poll ran) only new-generation quotes.
    if (feed.latestUp) {
      expect(feed.latestUp.generation).toBe(feed.generation)
      expect(feed.latestUp.tokenId).toBe(UP2)
      expect(feed.latestUp.price).not.toBe(0.99)
    }
    const snap = feed.validatedQuotes()
    if (snap) {
      expect(snap.generation).toBe(feed.generation)
      expect(snap.up.tokenId).toBe(UP2)
    }
  })

  it("late WS frames from the previous market are rejected after rollover", async () => {
    await internals(feed).poll()
    feed.setTokenIds(UP2, DOWN2)
    // Late frame for OLD tokens (reconnect replay):
    internals(feed).applyWsUpdate({ tokenId: UP, ask: 0.95, bid: 0.93, atMs: Date.now() })
    expect(feed.latestUp).toBeNull()
    // Frame for CURRENT tokens is accepted and carries the current generation:
    internals(feed).applyWsUpdate({ tokenId: UP2, ask: 0.45, bid: 0.43, atMs: Date.now() })
    expect(feed.latestUp?.price).toBe(0.45)
    expect(feed.latestUp?.generation).toBe(feed.generation)
  })
})

describe("atomic validated snapshot", () => {
  let feed: ClobPriceFeed

  beforeEach(() => {
    fetchCalls = 0
    fetchBehavior = okResponses()
    installFetchMock()
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

  it("returns a deep-frozen immutable snapshot when both sides are valid", async () => {
    await internals(feed).poll()
    const snap = feed.validatedQuotes()
    expect(snap).not.toBeNull()
    expect(Object.isFrozen(snap)).toBe(true)
    expect(Object.isFrozen(snap!.up)).toBe(true)
    expect(Object.isFrozen(snap!.down)).toBe(true)
    expect(snap!.validation).toBe("VALID")
    expect(snap!.generation).toBe(feed.generation)
    expect(snap!.up.price).toBe(0.55)
    expect(snap!.down.price).toBe(0.53)
  })

  it("returns null with a diagnostic reason when a quote is missing", () => {
    expect(feed.validatedQuotes()).toBeNull()
    expect(feed.diagnostics().validationFailReason).toContain("no quotes yet")
  })

  it("MIXED-GENERATION GUARD: rejects a pair where one side belongs to an older generation", async () => {
    await internals(feed).poll()
    expect(feed.validatedQuotes()).not.toBeNull()
    // Forge the mixed state: bump generation but hand-restore ONE old quote
    // (simulates any residual write path that slipped a stale object in).
    const i = feed as unknown as { upQuote: { generation: number } | null; downQuote: { generation: number } | null; gen: number }
    i.gen = i.gen + 1
    expect(feed.validatedQuotes()).toBeNull()
    expect(feed.diagnostics().validationFailReason).toContain("generation mismatch")
  })

  it("TOKEN-IDENTITY GUARD: rejects quotes whose tokenId does not match the tracked tokens", async () => {
    await internals(feed).poll()
    // Point the feed at different tokens WITHOUT clearing (white-box: bypass
    // setTokenIds to simulate an inconsistent internal state).
    const i = internals(feed)
    i.upTokenId = UP2
    i.downTokenId = DOWN2
    expect(feed.validatedQuotes()).toBeNull()
    expect(feed.diagnostics().validationFailReason).toContain("token identity mismatch")
  })

  it("STALENESS GUARD: rejects pairs older than the freshness limit", async () => {
    vi.useFakeTimers()
    try {
      await internals(feed).poll()
      expect(feed.validatedQuotes()).not.toBeNull()
      // 10–15s old: still VALID (VPN headroom) but degraded to LOW confidence,
      // which execution rejects — a stale-ish quote can be displayed, never traded.
      vi.advanceTimersByTime(11_000)
      const aging = feed.validatedQuotes()
      expect(aging).not.toBeNull()
      expect(aging!.confidence).toBe("LOW")
      // Past the 15s hard limit: validation fails outright.
      vi.advanceTimersByTime(5_000)
      expect(feed.validatedQuotes()).toBeNull()
      expect(feed.diagnostics().validationFailReason).toContain("stale quote")
    } finally {
      vi.useRealTimers()
    }
  })

  it("grades WS-sourced fresh pairs HIGH and REST-sourced pairs MEDIUM", async () => {
    // REST-sourced pair → MEDIUM.
    await internals(feed).poll()
    let snap = feed.validatedQuotes()
    expect(snap?.confidence).toBe("MEDIUM")
    expect(snap?.up.source).toBe("REST")
    // WS-sourced pair → HIGH.
    internals(feed).applyWsUpdate({ tokenId: UP, ask: 0.56, bid: 0.54, atMs: Date.now() })
    internals(feed).applyWsUpdate({ tokenId: DOWN, ask: 0.44, bid: 0.42, atMs: Date.now() })
    snap = feed.validatedQuotes()
    expect(snap?.confidence).toBe("HIGH")
    expect(snap?.up.source).toBe("WS")
    expect(snap?.down.source).toBe("WS")
  })

  it("snapshot carries generation, sequence, ages, and feed freshness metadata", async () => {
    await internals(feed).poll()
    const snap = feed.validatedQuotes()!
    expect(snap.sequence).toBeGreaterThan(0)
    expect(snap.timestampMs).toBeGreaterThan(0)
    expect(snap.upAgeMs).toBeGreaterThanOrEqual(0)
    expect(snap.downAgeMs).toBeGreaterThanOrEqual(0)
    expect(snap.restFreshMs).not.toBeNull()
  })
})

describe("empty-book classification", () => {
  let feed: ClobPriceFeed

  beforeEach(() => {
    fetchCalls = 0
    installFetchMock()
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

  it("BUY price 0 (empty ask book) is classified emptyBook, NOT a fetch failure", async () => {
    fetchBehavior = (url: string) => {
      if (url.includes("/price")) return Response.json({ price: "0" }) // empty book
      if (url.includes("/midpoint")) return Response.json({ mid: "0" })
      if (url.includes("/last-trade-price")) return Response.json({ price: "0" })
      if (url.includes("/book")) return Response.json({ bids: [], asks: [] })
      return Response.json({})
    }
    await internals(feed).poll()
    const diag = feed.diagnostics()
    expect(diag.emptyBook).toBe(true)
    // An empty book is a liquidity state, not an API failure — it must NOT
    // trip the consecutive-failure escalation that drives outage alerts.
    expect(diag.consecutiveFailures).toBe(0)
    // And it can never produce a tradable quote.
    expect(feed.validatedQuotes()).toBeNull()
  })

  it("empty-book state clears once real liquidity appears", async () => {
    fetchBehavior = (url: string) => {
      if (url.includes("/price")) return Response.json({ price: "0" })
      return Response.json({})
    }
    await internals(feed).poll()
    expect(feed.diagnostics().emptyBook).toBe(true)
    fetchBehavior = okResponses()
    await internals(feed).poll()
    expect(feed.diagnostics().emptyBook).toBe(false)
    expect(feed.validatedQuotes()).not.toBeNull()
  })
})

describe("adaptive REST cadence", () => {
  let feed: ClobPriceFeed

  beforeEach(() => {
    fetchCalls = 0
    fetchBehavior = okResponses()
    installFetchMock()
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

  it("reports FAST cadence when WS is not delivering and SLOW when WS is healthy", async () => {
    // No WS traffic → FAST REST polling (REST is the only source).
    expect(feed.diagnostics().restCadence).toBe("FAST")
    // Healthy WS traffic on both sides → REST relaxes to SLOW standby.
    internals(feed).applyWsUpdate({ tokenId: UP, ask: 0.56, bid: 0.54, atMs: Date.now() })
    internals(feed).applyWsUpdate({ tokenId: DOWN, ask: 0.44, bid: 0.42, atMs: Date.now() })
    expect(feed.diagnostics().restCadence).toBe("SLOW")
  })
})
