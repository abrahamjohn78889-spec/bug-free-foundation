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
// Integration tests for the DEFAULT engine: the Standing Limit Order manager.
//
// These drive the manager end-to-end in PAPER_V1 through its real quote-listener
// seam (the same callback the live CLOB feed fires on every price push) against
// fully in-memory feed/discovery/bankroll doubles and the real PaperExecutor +
// SQLite ledger. They verify the behaviors the audit must never regress:
// BTC-reference majority-side trigger, direction lock, one-order-per-window,
// and the no-live-data / out-of-band HOLD guards.
// ------------------------------------------------------------

// Shared fake CLOB price feed exposing exactly the surface the manager
// consumes, including the Phase 1 validatedQuotes() atomic-snapshot API.
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

interface Harness {
  mgr: StandingOrderManager
  feed: FakeClobFeed
  bankroll: { balance: number; dustReserve: number; debitFixed: (c: number) => void }
  setPrices: (up: number | null, down: number | null) => void
  setSpot: (price: number) => void
  driveTick: () => Promise<void>
  snap: () => ReturnType<StandingOrderManager["snapshot"]>
}

const live: StandingOrderManager[] = []

async function flush(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

const SLOT = 5 * 60_000

function pinClock(intoSlotMs: number): number {
  const slotStart = Math.ceil(Date.now() / SLOT) * SLOT + SLOT
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(slotStart + intoSlotMs)
  return slotStart + SLOT
}

function makeHarness(): Harness {
  const feed = new FakeClobFeed()
  let spotPrice = 100_000
  const bankroll = {
    balance: 1000,
    dustReserve: 0,
    debitFixed(c: number) {
      this.balance -= c
    },
  }
  const spotFeed = {
    get latest() {
      return { price: spotPrice, tsMs: Date.now(), source: "chainlink-onchain" as const }
    },
    onTick: () => () => {},
    start() {},
    stop() {},
  } as unknown as BtcReferenceFeed

  const discovery = {
    // Always return a market keyed to whatever slot the manager asks about, so
    // the manager's current-slot market is always present.
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
    setPrices: (up, down) => feed.setPrices(up, down),
    setSpot: (price) => {
      spotPrice = price
    },
    driveTick: async () => {
      feed.listener?.()
      await flush()
    },
    snap: () => mgr.snapshot(),
  }
}

beforeAll(() => {
  // Start from a clean ledger so settlement rows from a prior run never bleed in.
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
  // Stop every manager's interval + listener so no loop leaks across tests.
  while (live.length) live.pop()!.dispose()
  vi.useRealTimers()
})

describe("StandingOrderManager — BTC-reference majority trigger + direction lock", () => {
  it("locks UP when BTC-reference majority is UP and UP reaches the trigger", async () => {
    pinClock(1_000)
    const h = makeHarness()
    // UP already at the trigger, DOWN far away.
    h.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    h.setSpot(100_100)
    await h.driveTick()

    const s = h.snap()!
    expect(s.lockedDirection).toBe("UP")
    expect(s.executionCount).toBe(1)
    expect(s.status).toBe("FILLED")
    expect(s.openPositionCount).toBe(1)
    expect(s.openPosition?.side).toBe("UP")
    expect(s.openPosition?.shares).toBe(10)
  })

  it("locks DOWN when BTC-reference majority is DOWN and DOWN reaches the trigger", async () => {
    pinClock(1_000)
    const h = makeHarness()
    h.setPrices(0.2, 0.92)
    h.mgr.arm(0.92, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    h.setSpot(99_900)
    await h.driveTick()

    const s = h.snap()!
    expect(s.lockedDirection).toBe("DOWN")
    expect(s.executionCount).toBe(1)
    expect(s.openPosition?.side).toBe("DOWN")
  })

  it("ignores a minority-side trigger touch until the BTC-reference majority side reaches the trigger", async () => {
    pinClock(1_000)
    const h = makeHarness()
    // Regression for the observed production shape: DOWN reaches the trigger,
    // but BTC is above the candle strike, so the majority strategy is UP.
    h.setPrices(0.5, 0.5)
    h.mgr.arm(0.92, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    h.setSpot(100_100)
    h.setPrices(0.5, 0.92)
    await h.driveTick()

    let s = h.snap()!
    expect(s.majoritySide).toBe("UP")
    expect(s.lockedDirection).toBeNull()
    expect(s.executionCount).toBe(0)
    expect(s.openPositionCount).toBe(0)

    h.setPrices(0.92, 0.2)
    await h.driveTick()
    s = h.snap()!
    expect(s.lockedDirection).toBe("UP")
    expect(s.executionCount).toBe(1)
    expect(s.openPosition?.side).toBe("UP")
  })

  it("keeps the lock and places no further orders after the window is filled", async () => {
    pinClock(1_000)
    const h = makeHarness()
    h.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    h.setSpot(100_100)
    await h.driveTick()
    expect(h.snap()!.executionCount).toBe(1)

    // Flip so DOWN is now decisively higher. A locked, window-filled engine must
    // ignore the opposite side entirely — no second order, no re-lock.
    h.setPrices(0.4, 0.99)
    await h.driveTick()
    await h.driveTick()

    const s = h.snap()!
    expect(s.lockedDirection).toBe("UP")
    expect(s.executionCount).toBe(1)
    expect(s.openPositionCount).toBe(1)
    expect(s.status).toBe("FILLED")
  })
})

describe("StandingOrderManager — safety guards", () => {
  it("HOLDS with NO_DATA when the live CLOB feed is not fresh (never invents a price)", async () => {
    pinClock(1_000)
    const h = makeHarness()
    h.feed.freshFlag = false
    h.setPrices(null, null)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()

    const s = h.snap()!
    expect(s.status).toBe("NO_DATA")
    expect(s.executionCount).toBe(0)
    expect(s.lockedDirection).toBeNull()
    expect(s.openPositionCount).toBe(0)
  })

  it("HOLDS OUT_OF_RANGE when the triggered price is outside the guardrail band", async () => {
    pinClock(1_000)
    const h = makeHarness()
    // UP qualifies for the trigger (0.60 >= 0.40) but is above the max band (0.50).
    h.setPrices(0.6, 0.1)
    h.mgr.arm(0.45, 10, 5, 0.01, 0.5, 0.4, "AT_OR_ABOVE")
    await flush()
    h.setSpot(100_100)
    await h.driveTick()

    const s = h.snap()!
    expect(s.status).toBe("OUT_OF_RANGE")
    expect(s.executionCount).toBe(0)
    expect(s.openPositionCount).toBe(0)
  })

  it("stays ARMED (no fill) while both sides are below the trigger", async () => {
    pinClock(1_000)
    const h = makeHarness()
    h.setPrices(0.5, 0.5)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    h.setSpot(100_100)
    await h.driveTick()

    const s = h.snap()!
    expect(s.status).toBe("ARMED")
    expect(s.executionCount).toBe(0)
    expect(s.lockedDirection).toBeNull()

    // Now push UP through the trigger — it should lock and fill on the next tick.
    h.setPrices(0.9, 0.5)
    await h.driveTick()
    const s2 = h.snap()!
    expect(s2.lockedDirection).toBe("UP")
    expect(s2.executionCount).toBe(1)
  })
})
