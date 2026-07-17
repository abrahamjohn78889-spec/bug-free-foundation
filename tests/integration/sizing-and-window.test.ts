import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { StandingOrderManager } from "@/lib/v2/engine/standing-order"
import { RiskManager } from "@/lib/v2/engine/risk"
import type { Bankroll } from "@/lib/v2/engine/bankroll"
import type { ClobPriceFeed } from "@/lib/v2/engine/feeds/clob-price-feed"
import type { BtcReferenceFeed } from "@/lib/v2/engine/feeds/btc-reference-feed"
import type { MarketDiscovery, DiscoveredMarket } from "@/lib/v2/engine/feeds/market-discovery"

// ------------------------------------------------------------
// Regression tests: automatic compounding (PERCENT / FIXED_USD sizing
// computed from the live bankroll at fire time) and the FINAL ENTRY
// WINDOW (trigger may only fire during the last N seconds before the
// market settles; pre-window price touches are never remembered).
// ------------------------------------------------------------

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

async function flush(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

function makeHarness(startingBalance = 1000) {
  const feed = new FakeClobFeed()
  const bankroll = {
    balance: startingBalance,
    dustReserve: 0,
    debitFixed(c: number) {
      this.balance -= c
    },
    settle(payout: number) {
      this.balance += payout
    },
  }
  const spotFeed = {
    get latest() {
      return { price: 100_000, tsMs: Date.now(), source: "chainlink-onchain" as const }
    },
    onTick: () => () => {},
    start() {},
    stop() {},
  } as unknown as BtcReferenceFeed

  const discovery = {
    peek: (slot: number) => makeMarket(slot),
    resolve: async (slot: number) => makeMarket(slot),
    refreshMarket: async (slot: number) => makeMarket(slot),
    fetchResolution: async () => null,
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

  return {
    mgr,
    feed,
    bankroll,
    setPrices: (up: number | null, down: number | null) => feed.setPrices(up, down),
    driveTick: async () => {
      feed.listener?.()
      await flush()
    },
    snap: () => mgr.snapshot(),
  }
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
  while (live.length) live.pop()!.dispose()
  vi.useRealTimers()
})

const SLOT = 5 * 60_000

/** Pin the wall clock to `intoSlotMs` after the start of a fresh 5-min slot. */
function pinClock(intoSlotMs: number): number {
  const slotStart = Math.ceil(Date.now() / SLOT) * SLOT + SLOT // a future, clean slot boundary
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(slotStart + intoSlotMs)
  return slotStart + SLOT // slotEndMs
}

describe("PERCENT sizing — automatic compounding", () => {
  it("sizes the order as a percent of the CURRENT pool at fire time", async () => {
    const h = makeHarness(1000)
    h.setPrices(0.9, 0.2)
    // 10% of $1000 = $100 → floor(100 / 0.90) = 111 shares
    const msg = h.mgr.arm(0.9, 0, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", {
      sizingMode: "PERCENT",
      sizeValue: 10,
    })
    expect(msg).toContain("armed")
    await flush()

    const s = h.snap()!
    expect(s.executionCount).toBe(1)
    expect(s.openPosition?.shares).toBe(111)
    expect(s.sizingMode).toBe("PERCENT")
    expect(s.sizeValue).toBe(10)
  })

  it("rejects PERCENT outside 1–100 at arm time", () => {
    const h = makeHarness(1000)
    expect(h.mgr.arm(0.9, 0, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { sizingMode: "PERCENT", sizeValue: 0 })).toContain(
      "between 1 and 100",
    )
    expect(h.mgr.arm(0.9, 0, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { sizingMode: "PERCENT", sizeValue: 150 })).toContain(
      "between 1 and 100",
    )
  })

  it("caps computed shares at the risk maxSharesPerOrder", async () => {
    const h = makeHarness(1_000_000)
    // Prices BELOW the trigger so nothing fires — this test only checks the
    // sizing clamp exposed through the snapshot (the PaperExecutor's sim
    // wallet is $100 and can never fund a clamp-sized order anyway).
    h.setPrices(0.2, 0.1)
    // 100% of $1M at $0.40 would be 2.5M shares — must clamp to the risk cap (1000).
    h.mgr.arm(0.4, 0, 5, 0.01, 0.99, 0.4, "AT_OR_ABOVE", { sizingMode: "PERCENT", sizeValue: 100 })
    await flush()
    const s = h.snap()!
    expect(s.executionCount).toBe(0)
    expect(s.shares).toBe(1000)
  })
})

describe("FIXED_USD sizing", () => {
  it("buys floor(usd / limitPrice) shares", async () => {
    const h = makeHarness(1000)
    h.setPrices(0.9, 0.2)
    // $50 at $0.90 → 55 shares
    h.mgr.arm(0.9, 0, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { sizingMode: "FIXED_USD", sizeValue: 50 })
    await flush()
    const s = h.snap()!
    expect(s.executionCount).toBe(1)
    expect(s.openPosition?.shares).toBe(55)
  })

  it("rejects a dollar amount that buys fewer than minShares", () => {
    const h = makeHarness(1000)
    // $1 at $0.90 → 1 share < minShares 5
    const msg = h.mgr.arm(0.9, 0, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { sizingMode: "FIXED_USD", sizeValue: 1 })
    expect(msg).toContain("fewer than")
  })
})

describe("FIXED_SHARES sizing — legacy behavior preserved", () => {
  it("buys exactly the configured share count", async () => {
    const h = makeHarness(1000)
    h.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    const s = h.snap()!
    expect(s.executionCount).toBe(1)
    expect(s.openPosition?.shares).toBe(10)
    expect(s.sizingMode).toBe("FIXED_SHARES")
  })
})

// ------------------------------------------------------------
// FINAL ENTRY WINDOW — the window is the LAST N seconds before settlement:
//   eligible ⇔ (slotEndMs − now) ≤ entryWindowMs
// Before it opens the engine monitors live prices but never places, and
// never remembers pre-window trigger touches. The window closes at
// settlement; rollover re-arms automatically for the next market.
// ------------------------------------------------------------
describe("Final entry window (before settlement)", () => {
  it("does NOT fire while the window has not opened yet (WINDOW_WAITING)", async () => {
    pinClock(10_000) // 10s into the slot → 290s remaining > 30s window
    const h = makeHarness(1000)
    h.setPrices(0.9, 0.2) // price AT trigger the whole time
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { entryWindowSec: 30 })
    await flush()
    await h.driveTick()

    const s = h.snap()!
    expect(s.executionCount).toBe(0)
    expect(s.openPositionCount).toBe(0)
    expect(s.status).toBe("WINDOW_WAITING")
    expect(s.entryWindowMs).toBe(30_000)
    // 290s remaining − 30s window = 260s until the window opens
    expect(s.entryWindowOpensInMs).toBeGreaterThan(255_000)
    expect(s.entryWindowOpensInMs).toBeLessThanOrEqual(260_000)
  })

  it("fires normally once remaining time ≤ configured window", async () => {
    pinClock(SLOT - 20_000) // 20s remaining ≤ 30s window → ACTIVE
    const h = makeHarness(1000)
    h.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { entryWindowSec: 30 })
    await flush()
    const s = h.snap()!
    expect(s.executionCount).toBe(1)
    expect(s.entryWindowOpensInMs).toBe(0)
  })

  it("activates exactly at the boundary (remaining == window)", async () => {
    pinClock(SLOT - 30_000) // exactly 30s remaining, 30s window
    const h = makeHarness(1000)
    h.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { entryWindowSec: 30 })
    await flush()
    expect(h.snap()!.executionCount).toBe(1)
  })

  it("NEVER remembers a pre-window trigger touch — fresh in-window crossing fires (UPWARD_CROSSING)", async () => {
    // Phase 1: price crosses the trigger EARLY (long before the window opens),
    // then falls back below. Phase 2: the window opens with the price BELOW
    // the trigger. The earlier crossing must leave NO trace — only a fresh
    // crossing INSIDE the window may fire.
    const slotEndMs = pinClock(10_000)
    const h = makeHarness(1000)
    h.setPrices(0.95, 0.2) // early touch: at/above the 0.9 trigger
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "UPWARD_CROSSING", { entryWindowSec: 30 })
    await flush()
    await h.driveTick()
    expect(h.snap()!.executionCount).toBe(0) // early touch ignored

    // Price falls away before the window opens.
    h.setPrices(0.5, 0.2)
    await h.driveTick()

    // Window opens (25s remaining ≤ 30s window) with price below trigger.
    vi.setSystemTime(slotEndMs - 25_000)
    await h.driveTick()
    expect(h.snap()!.executionCount).toBe(0) // below trigger — still nothing

    // A live in-window upward crossing — THIS fires. Price 0.90 == the limit,
    // so the buy is marketable and fills immediately (0.95 would rest).
    h.setPrices(0.9, 0.2)
    await h.driveTick()
    expect(h.snap()!.executionCount).toBe(1)
  })

  it("pre-window elevated price does NOT fire at window open without a fresh in-window crossing (UPWARD_CROSSING)", async () => {
    // Price sits at/above the trigger continuously from before the window
    // opens. Opening the window must NOT fire — the crossing happened
    // outside the window and must not be remembered.
    const slotEndMs = pinClock(10_000)
    const h = makeHarness(1000)
    h.setPrices(0.95, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "UPWARD_CROSSING", { entryWindowSec: 30 })
    await flush()
    await h.driveTick()
    expect(h.snap()!.executionCount).toBe(0)

    vi.setSystemTime(slotEndMs - 25_000) // window opens; price never dipped
    await h.driveTick()
    await h.driveTick()
    expect(h.snap()!.executionCount).toBe(0) // no fresh in-window crossing → no fire

    // Now a genuine in-window crossing: below → at trigger. Price 0.90 == the
    // limit, so the buy is marketable and fills immediately.
    h.setPrices(0.5, 0.2)
    await h.driveTick()
    h.setPrices(0.9, 0.2)
    await h.driveTick()
    expect(h.snap()!.executionCount).toBe(1)
  })

  it("every supported window activates at its boundary and never 1s early", async () => {
    for (const sec of [5, 15, 30, 45, 60, 90, 120]) {
      const slotEndMs = pinClock(SLOT - (sec * 1000 + 1000)) // 1s BEFORE the boundary
      const h = makeHarness(1000)
      h.setPrices(0.9, 0.2)
      h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { entryWindowSec: sec })
      await flush()
      await h.driveTick()
      expect(h.snap()!.executionCount, `window ${sec}s must NOT fire 1s early`).toBe(0)
      expect(h.snap()!.status, `window ${sec}s should be WINDOW_WAITING 1s early`).toBe("WINDOW_WAITING")

      vi.setSystemTime(slotEndMs - sec * 1000) // exactly AT the boundary
      await h.driveTick()
      expect(h.snap()!.executionCount, `window ${sec}s must fire at the boundary`).toBe(1)

      live.pop()!.dispose()
      vi.useRealTimers()
    }
  })

  it("rejects an invalid window duration at arm time and accepts 45s", () => {
    const h = makeHarness(1000)
    expect(h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { entryWindowSec: 7 })).toContain("Time window")
    expect(h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { entryWindowSec: 45 })).toContain("armed")
  })

  it("window disabled (null) never blocks the trigger", async () => {
    pinClock(240_000) // deep into the slot
    const h = makeHarness(1000)
    h.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    const s = h.snap()!
    expect(s.executionCount).toBe(1)
    expect(s.entryWindowMs).toBeNull()
    expect(s.entryWindowOpensInMs).toBeNull()
  })

  it("window settings survive a restart (persistence restore)", async () => {
    pinClock(10_000)
    const h = makeHarness(1000)
    h.setPrices(0.5, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { entryWindowSec: 45 })
    await flush()

    // Simulate a PM2 restart: a brand-new manager restores from disk.
    const h2 = makeHarness(1000)
    await flush()
    const s2 = h2.snap()
    expect(s2).not.toBeNull()
    expect(s2!.entryWindowMs).toBe(45_000)
  })
})
