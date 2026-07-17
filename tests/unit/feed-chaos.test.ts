// ============================================================================
// FEED CHAOS TESTS — REST 429 backoff, timeouts, DNS failure, malformed and
// duplicate WS frames, market rollover during reconnect
// ============================================================================
// The ClobPriceFeed and ClobWsClient are driven with a mocked global fetch
// and direct frame injection so every network failure mode is deterministic.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ClobPriceFeed } from "@/lib/v2/engine/feeds/clob-price-feed"
import { ClobWsClient, type WsBestAsk } from "@/lib/v2/engine/feeds/clob-ws-client"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UP = "token-up-111"
const DOWN = "token-down-222"

type FetchMode = "ok" | "http-429" | "http-503" | "timeout" | "dns-fail" | "garbage-json"

let fetchMode: FetchMode = "ok"
let fetchCalls = 0

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      fetchCalls++
      const url = String(input)
      switch (fetchMode) {
        case "http-429":
          return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" })
        case "http-503":
          return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" })
        case "timeout":
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
        case "dns-fail":
          throw new TypeError("fetch failed: getaddrinfo ENOTFOUND clob.polymarket.com")
        case "garbage-json":
          return new Response("<html>gateway error</html>", { status: 200 })
        case "ok": {
          if (url.includes("/price")) return Response.json({ price: url.includes("side=BUY") ? "0.55" : "0.53" })
          if (url.includes("/midpoint")) return Response.json({ mid: "0.54" })
          if (url.includes("/last-trade-price")) return Response.json({ price: "0.55", side: "BUY" })
          if (url.includes("/book"))
            return Response.json({ bids: [{ price: "0.53", size: "100" }], asks: [{ price: "0.55", size: "100" }] })
          return Response.json({})
        }
      }
    }),
  )
}

/** Access private members for white-box chaos injection. */
function internals(feed: ClobPriceFeed) {
  return feed as unknown as {
    poll: () => Promise<void>
    stopped: boolean
    upTokenId: string | null
    downTokenId: string | null
    restBackoffUntilMs: number
  }
}

describe("ClobPriceFeed REST chaos", () => {
  let feed: ClobPriceFeed

  beforeEach(() => {
    fetchMode = "ok"
    fetchCalls = 0
    installFetchMock()
    feed = new ClobPriceFeed()
    // Set tokens WITHOUT start() — we drive poll() manually and keep the WS off.
    const i = internals(feed)
    i.stopped = false
    i.upTokenId = UP
    i.downTokenId = DOWN
  })

  afterEach(() => {
    feed.stop()
    vi.unstubAllGlobals()
  })

  it("healthy poll produces fresh quotes for both sides", async () => {
    await internals(feed).poll()
    expect(feed.fresh).toBe(true)
    expect(feed.latestUp?.ask).toBe(0.55)
    expect(feed.latestDown?.ask).toBe(0.55)
  })

  it("HTTP 429 engages REST backoff — subsequent polls are skipped (no hammering)", async () => {
    fetchMode = "http-429"
    await internals(feed).poll()
    expect(internals(feed).restBackoffUntilMs).toBeGreaterThan(Date.now())
    const callsAfter429 = fetchCalls
    // Next poll during backoff must make ZERO network calls.
    await internals(feed).poll()
    expect(fetchCalls).toBe(callsAfter429)
    // After backoff expires, polling resumes.
    internals(feed).restBackoffUntilMs = Date.now() - 1
    fetchMode = "ok"
    await internals(feed).poll()
    expect(feed.fresh).toBe(true)
  })

  it("REST timeout marks the feed stale instead of inventing a price", async () => {
    fetchMode = "timeout"
    await internals(feed).poll()
    expect(feed.fresh).toBe(false)
    expect(feed.latestUp).toBeNull()
    expect(feed.diagnostics().consecutiveFailures).toBeGreaterThanOrEqual(1)
  })

  it("DNS failure (ENOTFOUND) is survived and recovery is immediate when DNS returns", async () => {
    fetchMode = "dns-fail"
    await internals(feed).poll()
    await internals(feed).poll()
    expect(feed.fresh).toBe(false)
    expect(feed.diagnostics().consecutiveFailures).toBe(2)
    fetchMode = "ok"
    await internals(feed).poll()
    expect(feed.fresh).toBe(true)
    expect(feed.diagnostics().consecutiveFailures).toBe(0)
  })

  it("garbage JSON from a proxy/gateway never produces a quote", async () => {
    fetchMode = "garbage-json"
    await internals(feed).poll()
    expect(feed.fresh).toBe(false)
    expect(feed.latestUp).toBeNull()
  })

  it("HTTP 503 outage → stale, then full recovery (Polymarket API outage chaos)", async () => {
    fetchMode = "http-503"
    for (let i = 0; i < 5; i++) await internals(feed).poll()
    expect(feed.fresh).toBe(false)
    expect(feed.diagnostics().consecutiveFailures).toBe(5)
    fetchMode = "ok"
    await internals(feed).poll()
    expect(feed.fresh).toBe(true)
  })

  it("market rollover invalidates old-slot prices immediately (never carried over)", async () => {
    await internals(feed).poll()
    expect(feed.fresh).toBe(true)
    // Rollover to the next 5-min slot's tokens.
    feed.setTokenIds("token-up-333", "token-down-444")
    // Old prices must be GONE before the first new-slot poll completes.
    expect(feed.latestUp).toBeNull()
    expect(feed.latestDown).toBeNull()
    expect(feed.fresh).toBe(false)
  })
})

describe("ClobWsClient frame chaos", () => {
  let updates: WsBestAsk[]
  let client: ClobWsClient

  function inject(frame: unknown) {
    ;(client as unknown as { handleMessage: (t: string) => void }).handleMessage(
      typeof frame === "string" ? frame : JSON.stringify(frame),
    )
  }

  beforeEach(() => {
    updates = []
    client = new ClobWsClient((u) => updates.push(u))
    client.setAssets([UP, DOWN])
  })

  it("processes a valid best_bid_ask frame", () => {
    inject({ event_type: "best_bid_ask", asset_id: UP, best_ask: "0.61", best_bid: "0.59" })
    expect(updates.length).toBe(1)
    expect(updates[0]).toMatchObject({ tokenId: UP, ask: 0.61, bid: 0.59 })
  })

  it("duplicate frames are idempotent — same price twice is harmless", () => {
    const frame = { event_type: "best_bid_ask", asset_id: UP, best_ask: "0.61", best_bid: "0.59" }
    inject(frame)
    inject(frame) // duplicate delivery (reconnect replay / server dup)
    expect(updates.length).toBe(2)
    expect(updates[0].ask).toBe(updates[1].ask) // consumer sees same value → no state change
  })

  it("survives malformed frames: not JSON, PONG, null, wrong shapes", () => {
    expect(() => {
      inject("this is not json {{{")
      inject("PONG")
      inject("null")
      inject({ event_type: "best_bid_ask" }) // missing asset_id
      inject({ event_type: "best_bid_ask", asset_id: UP, best_ask: "not-a-number" })
      inject({ event_type: "best_bid_ask", asset_id: UP, best_ask: "1.5" }) // out of range
      inject({ event_type: "best_bid_ask", asset_id: UP, best_ask: "-0.1" }) // out of range
      inject({ event_type: "unknown_type", asset_id: UP })
      inject([{ event_type: "best_bid_ask", asset_id: UP, best_ask: "0.5" }, "garbage", null])
    }).not.toThrow()
    // Only the two valid asks (array one + none of the malformed) got through.
    expect(updates.length).toBe(1)
    expect(updates[0].ask).toBe(0.5)
  })

  it("book snapshot picks LOWEST ask and HIGHEST bid (worst→best ordering)", () => {
    inject({
      event_type: "book",
      asset_id: UP,
      asks: [
        { price: "0.99", size: "10" },
        { price: "0.62", size: "10" },
        { price: "0.61", size: "10" },
      ],
      bids: [
        { price: "0.01", size: "10" },
        { price: "0.58", size: "10" },
        { price: "0.59", size: "10" },
      ],
    })
    expect(updates.length).toBe(1)
    expect(updates[0].ask).toBe(0.61)
    expect(updates[0].bid).toBe(0.59)
  })

  it("price_change batch applies each contained token update", () => {
    inject({
      event_type: "price_change",
      price_changes: [
        { asset_id: UP, best_ask: "0.7", best_bid: "0.68" },
        { asset_id: DOWN, best_ask: "0.31", best_bid: "0.29" },
        { asset_id: "unrelated-token", best_ask: "0.5" }, // still forwarded; feed filters by token
      ],
    })
    expect(updates.length).toBe(3)
    expect(updates[0]).toMatchObject({ tokenId: UP, ask: 0.7 })
    expect(updates[1]).toMatchObject({ tokenId: DOWN, ask: 0.31 })
  })

  it("feed ignores WS updates for tokens from a PREVIOUS slot (rollover during reconnect)", () => {
    const feed = new ClobPriceFeed()
    const i = feed as unknown as { upTokenId: string | null; downTokenId: string | null; applyWsUpdate: (u: WsBestAsk) => void }
    i.upTokenId = "new-up"
    i.downTokenId = "new-down"
    // A late frame for the OLD slot arrives after rollover:
    i.applyWsUpdate({ tokenId: "old-up", ask: 0.9, bid: 0.88, atMs: Date.now() })
    expect(feed.latestUp).toBeNull()
    expect(feed.latestDown).toBeNull()
    // A frame for the CURRENT slot is applied:
    i.applyWsUpdate({ tokenId: "new-up", ask: 0.4, bid: 0.38, atMs: Date.now() })
    expect(feed.latestUp?.ask).toBe(0.4)
  })
})
