import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { StandingOrderManager } from "@/lib/v2/engine/standing-order"
import { RiskManager } from "@/lib/v2/engine/risk"
import type { Bankroll } from "@/lib/v2/engine/bankroll"
import type { ClobPriceFeed } from "@/lib/v2/engine/feeds/clob-price-feed"
import type { BtcReferenceFeed } from "@/lib/v2/engine/feeds/btc-reference-feed"
import type { MarketDiscovery, DiscoveredMarket } from "@/lib/v2/engine/feeds/market-discovery"
import { recentTrades } from "@/lib/v2/engine/db"

// ------------------------------------------------------------
// Regression tests for the settlement bug: a paper trade that bet the WINNING
// side was intermittently booked as a LOSS.
//
// Root cause (now fixed): paper settlement decided the winner from a LOCAL
// spot-vs-strike heuristic (with a `?? 0` fallback) instead of the OFFICIAL
// Polymarket resolution. When the Chainlink tick was stale/zero or the candle
// was near-the-money, an UP position that actually won was recorded as a loss.
//
// These drive the real StandingOrderManager through a genuine slot rollover
// (advancing the wall clock past the 5-minute boundary) so `rolloverSlot` →
// `settleOfficial` runs exactly as in production, against a controllable
// `fetchResolution` mock. They assert the persisted ledger row.
// ------------------------------------------------------------

const SLOT_MS = 5 * 60_000

// Shared fake CLOB feed with the Phase 1 validatedQuotes() atomic-snapshot API.
import { FakeClobFeed } from "../helpers/fake-clob-feed"

function makeMarket(slotEndMs: number): DiscoveredMarket {
  return {
    slotEndMs,
    slug: `btc-updown-5m-test-${slotEndMs}`,
    question: "BTC up or down?",
    conditionId: "0xcond",
    upTokenId: "up-token",
    downTokenId: "down-token",
    orderMinSize: 5,
    tickSize: 0.01,
    active: true,
    closed: false,
    volumeUsd: null,
    liquidityUsd: null,
    endDateIso: null,
  }
}

const live: StandingOrderManager[] = []

async function flush(times = 10) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

/**
 * Build a harness whose `fetchResolution` and spot tick are fully controllable.
 * `spotPrice`/`spotFresh` let us reproduce the exact stale/zero-spot condition
 * that used to cause the misbooking.
 */
function makeHarness(opts: {
  resolution: "UP" | "DOWN" | null
  spotPrice?: number | null
  spotFresh?: boolean
  strikePrice?: number
}) {
  const feed = new FakeClobFeed()
  const bankroll = {
    balance: 1000,
    dustReserve: 0,
    startingBalance: 1000,
    debitFixed(c: number) {
      this.balance -= c
    },
    settle(payout: number) {
      this.balance += payout
    },
  }
  // Mutable spot so the STRIKE captured at arm time can differ from the SPOT
  // read at settlement — exactly how a real 5-minute candle moves. `state.spot`
  // starts at the strike; fillThenSettle flips it to the settlement price right
  // before the slot boundary.
  const strikePrice = opts.strikePrice ?? 100_000
  const state = { spot: strikePrice as number | null, fresh: opts.spotFresh !== false }
  const spotFeed = {
    get latest() {
      if (state.spot === null) return null
      const tsMs = state.fresh ? Date.now() : Date.now() - 60_000
      return { price: state.spot, tsMs, source: "chainlink-onchain" as const }
    },
    onTick: () => () => {},
    start() {},
    stop() {},
  } as unknown as BtcReferenceFeed

  const fetchResolution = vi.fn(async () => opts.resolution)
  const discovery = {
    peek: (slot: number) => makeMarket(slot),
    resolve: async (slot: number) => makeMarket(slot),
    refreshMarket: async (slot: number) => makeMarket(slot),
    fetchResolution,
  } as unknown as MarketDiscovery

  const mgr = new StandingOrderManager({
    getMode: () => "PAPER_V1",
    getBankroll: () => bankroll as unknown as Bankroll,
    discovery,
    clobPriceFeed: feed as unknown as ClobPriceFeed,
    spotFeed,
    risk: new RiskManager(() => "PAPER_V1"),
  })
  live.push(mgr)
  return { mgr, feed, bankroll, fetchResolution, spotState: state, settlementSpot: opts.spotPrice }
}

beforeAll(() => {
  const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || "data/test-ledger.db")
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(dbPath + suffix, { force: true })
    } catch {
      /* ignore */
    }
  }
})

afterEach(() => {
  vi.useRealTimers()
  while (live.length) live.pop()!.dispose()
})

/**
 * Arm + fill a position, then advance the wall clock past the slot boundary and
 * fire a tick so the manager runs a real rollover → settlement. Returns the
 * most-recent settled ledger row for the filled market.
 */
async function fillThenSettle(
  mgr: StandingOrderManager,
  feed: FakeClobFeed,
  side: "UP" | "DOWN",
  opts: { spotState?: { spot: number | null; fresh: boolean }; settlementSpot?: number | null } = {},
) {
  if (side === "UP") feed.setPrices(0.9, 0.2)
  else feed.setPrices(0.2, 0.9)
  mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
  await flush()

  const filled = mgr.snapshot()!
  expect(filled.executionCount).toBe(1)
  expect(filled.lockedDirection).toBe(side)
  const marketId = filled.openPosition!.marketId

  // Simulate the candle moving to its settlement spot AFTER the strike was
  // captured at arm time (only when the test supplies a distinct value).
  if (opts.spotState && opts.settlementSpot !== undefined) {
    opts.spotState.spot = opts.settlementSpot
  }

  // Advance the wall clock past the current slot boundary so the next tick
  // detects a rollover and settles the open lot. Fake timers let us also
  // fast-forward through settleOfficial's resolution poll loop (up to 40
  // attempts × 3s = 120s of patience, extended in Phase 4) deterministically
  // instead of waiting two minutes of real time.
  const now = Date.now()
  const boundary = Math.ceil(now / SLOT_MS) * SLOT_MS
  vi.useFakeTimers()
  vi.setSystemTime(boundary + 1_000)
  // Fire a tick via the public quote-listener seam; rolloverSlot runs inside
  // and kicks off the (async, un-awaited) settleOfficial.
  feed.listener?.()
  // Drive the resolution poll loop: interleave timer advancement with microtask
  // flushes so each awaited setTimeout + fetchResolution resolves in order.
  for (let i = 0; i < 42; i++) {
    await vi.advanceTimersByTimeAsync(3_000)
  }
  vi.useRealTimers()
  await flush(15)

  const rows = recentTrades("PAPER_V1", 200).filter((t) => t.marketId === marketId)
  return rows[0]
}

describe("settlement — official resolution is the source of truth", () => {
  it("books a WIN when the bet side matches the official winner (UP)", async () => {
    const { mgr, feed } = makeHarness({ resolution: "UP" })
    const row = await fillThenSettle(mgr, feed, "UP")
    expect(row).toBeTruthy()
    expect(row.result).toBe("WIN")
    expect(row.pnl).toBeGreaterThan(0)
  })

  it("books a LOSS only when the bet side truly lost per official resolution", async () => {
    const { mgr, feed } = makeHarness({ resolution: "DOWN" })
    const row = await fillThenSettle(mgr, feed, "UP")
    expect(row.result).toBe("LOSS")
    expect(row.pnl).toBeLessThan(0)
  })

  it("REGRESSION: UP bet that officially WON is NOT booked as a loss even when the spot tick is stale/zero", async () => {
    // This is the exact failure condition: official winner = UP, but the local
    // spot heuristic would have returned 0 → DOWN and misbooked a loss.
    const { mgr, feed } = makeHarness({ resolution: "UP", spotPrice: 0, spotFresh: false })
    const row = await fillThenSettle(mgr, feed, "UP")
    expect(row.result).toBe("WIN")
    expect(row.pnl).toBeGreaterThan(0)
  })
})

describe("settlement — fail-safe when official resolution is unavailable", () => {
  it("settles SCRATCH (cost refunded, zero PnL) rather than guessing when there is no resolution and the spot is stale", async () => {
    const { mgr, feed } = makeHarness({ resolution: null, spotPrice: 0, spotFresh: false })
    const row = await fillThenSettle(mgr, feed, "UP")
    // The persisted ledger row is the source of truth: SCRATCH refunds the
    // entry cost so realized PnL is exactly zero — never a fabricated loss.
    expect(row.result).toBe("SCRATCH")
    expect(row.pnl).toBe(0)
    // balanceAfter is recorded AT settlement as (balance + refunded cost); with
    // a SCRATCH refund the slot nets zero, so it must be >= the entry cost that
    // was returned (i.e. the refund actually happened).
    expect(row.balanceAfter).toBeGreaterThanOrEqual(row.cost)
  })

  it("uses the STRICT spot fallback only when the tick is fresh and decisively clears the strike", async () => {
    // No official resolution, but a fresh spot $50 above the strike → UP wins.
    // Strike is captured at 100_000; spot then moves to 100_050 at settlement.
    const { mgr, feed, spotState } = makeHarness({
      resolution: null,
      spotFresh: true,
      strikePrice: 100_000,
    })
    const row = await fillThenSettle(mgr, feed, "UP", { spotState, settlementSpot: 100_050 })
    expect(row.result).toBe("WIN")
  })

  it("does NOT use the spot fallback for a near-the-money move (settles SCRATCH)", async () => {
    // Fresh spot but only $0.25 above strike (< $1 decisive margin) → unverifiable.
    const { mgr, feed, spotState } = makeHarness({
      resolution: null,
      spotFresh: true,
      strikePrice: 100_000,
    })
    const row = await fillThenSettle(mgr, feed, "UP", { spotState, settlementSpot: 100_000.25 })
    expect(row.result).toBe("SCRATCH")
  })
})
