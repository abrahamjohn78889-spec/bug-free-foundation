// ============================================================================
// PHASE 6 — LONG-DURATION SOAK / CERTIFICATION TESTS
// ============================================================================
// Drives the REAL StandingOrderManager tick loop through 10,000+ market
// rollovers, quote-listener reconnect storms, process-restart churn, and
// discovery outages — against the real PaperExecutor and the real SQLite
// ledger. Only Date is faked (real timers/microtasks run) so the exact
// production async interleavings are exercised.
//
// Certifies: zero duplicate orders, zero ghost executions, zero stalled
// engines, zero DB corruption, bounded memory growth.
// ============================================================================

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { StandingOrderManager } from "@/lib/v2/engine/standing-order"
import { RiskManager } from "@/lib/v2/engine/risk"
import { getDbHandle, flushWriteQueueSync } from "@/lib/v2/engine/db"
import type { Bankroll } from "@/lib/v2/engine/bankroll"
import type { ClobPriceFeed } from "@/lib/v2/engine/feeds/clob-price-feed"
import type { BtcReferenceFeed } from "@/lib/v2/engine/feeds/btc-reference-feed"
import type { MarketDiscovery, DiscoveredMarket } from "@/lib/v2/engine/feeds/market-discovery"
import type { TradeSide } from "@/lib/v2/engine/types"
import { FakeClobFeed } from "../helpers/fake-clob-feed"

const SLOT_MS = 300_000

function makeMarket(slotEndMs: number): DiscoveredMarket {
  return {
    slotEndMs,
    slug: `btc-updown-5m-soak-${slotEndMs}`,
    question: "BTC up or down?",
    conditionId: `0xsoak-${slotEndMs}`,
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

async function flush(times = 2) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

function makeHarness(opts?: { resolution?: (slot: number) => TradeSide | null; refreshThrows?: () => boolean }) {
  const feed = new FakeClobFeed()
  const bankroll = {
    balance: 100_000,
    dustReserve: 0,
    startingBalance: 100_000,
    debitFixed(c: number) {
      this.balance = Math.round((this.balance - c) * 10000) / 10000
    },
    settle(p: number) {
      this.balance = Math.round((this.balance + p) * 10000) / 10000
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
    resolve: async (slot: number) => {
      if (opts?.refreshThrows?.()) throw new Error("simulated Gamma outage")
      return makeMarket(slot)
    },
    refreshMarket: async (slot: number) => {
      if (opts?.refreshThrows?.()) throw new Error("simulated Gamma outage")
      return makeMarket(slot)
    },
    fetchResolution: async (slot: number) => opts?.resolution?.(slot) ?? "UP",
  } as unknown as MarketDiscovery

  // The soak books MANY deliberate LOSS settles whose settled_at is the REAL
  // wall-clock date (SQLite date('now') ignores vi fake timers), so the
  // default $100/day loss breaker would legitimately engage mid-run and block
  // the remaining fill slots. This suite certifies engine hygiene (duplicates,
  // ghosts, stalls, leaks) — the breaker itself has dedicated tests — so raise
  // the cap out of the way and start from a disengaged kill switch.
  const risk = new RiskManager(() => "PAPER_V1")
  risk.setLimits({ maxDailyLossUsd: 1_000_000 })
  risk.disengageKillSwitch()

  const mgr = new StandingOrderManager({
    getMode: () => "PAPER_V1",
    getBankroll: () => bankroll as unknown as Bankroll,
    discovery,
    clobPriceFeed: feed as unknown as ClobPriceFeed,
    spotFeed,
    risk,
  })
  live.push(mgr)
  return { mgr, feed, bankroll }
}

beforeAll(() => {
  // Clear rows through the LIVE handle, not by deleting the file: the db
  // module's already-open handle would keep the old inode alive (rows from
  // other suites survive the unlink), and stale settled LOSS rows dated
  // "today" legitimately trip the RiskManager daily-loss gate, blocking the
  // soak's deliberate fill slots.
  flushWriteQueueSync()
  const db = getDbHandle()
  db.prepare("DELETE FROM trades").run()
  db.prepare("DELETE FROM order_log").run()
  // Also clear PERSISTED risk state: earlier suites settle deliberate losses,
  // which trips the daily-loss circuit breaker and engages the kv-persisted
  // kill switch. Every fresh RiskManager loads that at construction and would
  // block ALL soak fills with "kill switch engaged".
  db.prepare("DELETE FROM kv WHERE key LIKE 'risk:%'").run()
})

afterEach(() => {
  while (live.length) live.pop()!.dispose()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// 1. 10,000-ROLLOVER SOAK
// ---------------------------------------------------------------------------
describe("10,000-rollover soak", () => {
  it(
    "survives 10,000 slot rollovers with periodic fill/settle cycles: no duplicate orders, no ghost executions, no stall, bounded memory",
    { timeout: 300_000 },
    async () => {
      // Fake ONLY Date — real timers and microtasks keep production behavior.
      vi.useFakeTimers({ toFake: ["Date"] })
      const t0 = Math.ceil(1_900_000_000_000 / SLOT_MS) * SLOT_MS
      vi.setSystemTime(t0 - 60_000) // inside the first slot

      const h = makeHarness()
      // Armed with a HIGH trigger: fires only when we deliberately move price.
      h.feed.setPrices(0.5, 0.4)
      h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
      await flush(4)

      const heapBefore = process.memoryUsage().heapUsed
      const ROLLOVERS = 10_000
      const FILL_EVERY = 500 // 20 full fill→settle cycles across the soak
      let expectedFills = 0

      for (let i = 1; i <= ROLLOVERS; i++) {
        const slotEnd = t0 + i * SLOT_MS
        const isFillSlot = i % FILL_EVERY === 0

        if (isFillSlot) {
          // Move into the slot's entry window and let the trigger fire. The
          // ask must be AT the trigger (=limit) price: the paper book fills
          // only when liveAsk <= limit, exactly like the real CLOB.
          vi.setSystemTime(slotEnd - 30_000)
          h.feed.setPrices(0.9, 0.05)
          h.feed.listener?.() // trigger → submit (order now RESTING)
          await flush(6)
          expectedFills++
          // The paper executor's simulated network/matching legs run on REAL
          // timers (only Date is faked). A fixed flush count is a race: if we
          // roll the slot while the submit is still in flight, the manager
          // legitimately re-enters and a duplicate-order false positive
          // appears. Deterministically wait for the fill to land, firing
          // quote ticks like the production stream does.
          const deadline = performance.now() + 5_000
          while (h.mgr.snapshot()!.executionCount < expectedFills && performance.now() < deadline) {
            h.feed.listener?.() // fill check tick
            await new Promise((r) => setTimeout(r, 5)) // real 5ms for exec legs
          }
          h.feed.setPrices(0.5, 0.4) // back out of range for the next slots
        }

        // Cross the boundary → next tick detects rollover (and settles fills
        // against the immediate official resolution, no poll sleeps).
        vi.setSystemTime(slotEnd + 1_000)
        h.feed.listener?.()
        await flush(isFillSlot ? 6 : 1)
      }

      await flush(8)
      flushWriteQueueSync()

      const snap = h.mgr.snapshot()!
      // ZERO STALLED ENGINE: the final tick ran at (lastBoundary + 1s), whose
      // CURRENT slot ends one full slot later — the manager must sit exactly
      // there, proving every one of the 10,000 rollovers was processed.
      expect(snap.slotEndMs).toBe(t0 + (ROLLOVERS + 1) * SLOT_MS)
      // ZERO GHOST EXECUTIONS: exactly one execution per deliberate fill slot.
      expect(snap.executionCount).toBe(expectedFills)

      const db = getDbHandle()
      // ZERO DUPLICATE ORDERS: at most one trade per slot, unique trade uids.
      const dup = db
        .prepare(
          `SELECT slot_end_ms, COUNT(*) c FROM trades WHERE market_id LIKE 'btc-updown-5m-soak-%' GROUP BY slot_end_ms HAVING c > 1`,
        )
        .all()
      expect(dup).toEqual([])
      const uidDup = db
        .prepare(`SELECT trade_uid, COUNT(*) c FROM trades WHERE market_id LIKE 'btc-updown-5m-soak-%' GROUP BY trade_uid HAVING c > 1`)
        .all()
      expect(uidDup).toEqual([])
      const total = db.prepare(`SELECT COUNT(*) c FROM trades WHERE market_id LIKE 'btc-updown-5m-soak-%'`).get() as { c: number }
      expect(total.c).toBe(expectedFills)
      // ALL SETTLED — no orphaned open lots after 10k rollovers.
      const open = db
        .prepare(`SELECT COUNT(*) c FROM trades WHERE market_id LIKE 'btc-updown-5m-soak-%' AND status = 'OPEN'`)
        .get() as { c: number }
      expect(open.c).toBe(0)
      // Official resolution won every settle (never fallback/scratch).
      const scratch = db
        .prepare(`SELECT COUNT(*) c FROM trades WHERE market_id LIKE 'btc-updown-5m-soak-%' AND result = 'SCRATCH'`)
        .get() as { c: number }
      expect(scratch.c).toBe(0)

      // ZERO DATABASE CORRUPTION.
      const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>
      expect(integrity[0].integrity_check).toBe("ok")

      // BOUNDED MEMORY: 10k rollovers must not accumulate per-slot state.
      const heapGrowthMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024
      expect(heapGrowthMb).toBeLessThan(200)
    },
  )
})

// ---------------------------------------------------------------------------
// 2. RECONNECT STORM
// ---------------------------------------------------------------------------
describe("quote-listener reconnect storm", () => {
  it("1,000 rapid listener re-registrations + concurrent fires cause zero duplicate executions", async () => {
    const h = makeHarness()
    h.feed.setPrices(0.92, 0.05)
    h.mgr.arm(0.92, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush(6)
    expect(h.mgr.snapshot()!.executionCount).toBe(1)

    // Storm: the feed layer re-registers its listener (as a WS reconnect does)
    // and fires bursts — the busy/one-shot guards must hold.
    for (let i = 0; i < 1_000; i++) {
      const l = h.feed.listener
      h.feed.listener = null
      h.feed.listener = l
      h.feed.listener?.()
      if (i % 100 === 0) await flush(1)
    }
    await flush(8)

    // Still exactly ONE execution; engine alive; no error state.
    const snap = h.mgr.snapshot()!
    expect(snap.executionCount).toBe(1)
    expect(snap.openPositionCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. PROCESS-RESTART CHURN (PM2 restarts)
// ---------------------------------------------------------------------------
describe("restart churn", () => {
  it("100 create→arm→dispose cycles leave no active managers: disposed instances never execute again", async () => {
    const disposed: Array<{ mgr: StandingOrderManager; feed: FakeClobFeed }> = []
    for (let i = 0; i < 100; i++) {
      const h = makeHarness()
      h.feed.setPrices(0.5, 0.4) // out of range — no fills during churn
      h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
      await flush(1)
      h.mgr.dispose()
      disposed.push({ mgr: h.mgr, feed: h.feed })
    }
    // Fire every disposed feed with an IN-RANGE price: ghost-tick epoch guard
    // must reject every one of them (dispose bumped the epoch).
    flushWriteQueueSync()
    const before = (getDbHandle().prepare(`SELECT COUNT(*) c FROM trades`).get() as { c: number }).c
    for (const d of disposed) {
      d.feed.setPrices(0.95, 0.03)
      d.feed.listener?.()
    }
    await flush(8)
    flushWriteQueueSync()
    const after = (getDbHandle().prepare(`SELECT COUNT(*) c FROM trades`).get() as { c: number }).c
    expect(after).toBe(before) // zero executions from disposed managers
  })
})

// ---------------------------------------------------------------------------
// 4. DISCOVERY OUTAGE RESILIENCE (REST/Gamma outage)
// ---------------------------------------------------------------------------
describe("Gamma outage resilience", () => {
  it("keeps ticking through a discovery outage and recovers when the API returns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const t0 = Math.ceil(1_900_050_000_000 / SLOT_MS) * SLOT_MS
    vi.setSystemTime(t0 - 60_000)

    let outage = false
    const h = makeHarness({ refreshThrows: () => outage })
    h.feed.setPrices(0.5, 0.4)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush(4)

    // 50 rollovers with discovery hard-down: every resolve/refresh throws.
    outage = true
    for (let i = 1; i <= 50; i++) {
      vi.setSystemTime(t0 + i * SLOT_MS + 1_000)
      h.feed.listener?.()
      await flush(1)
    }
    // Engine must still be alive (not stalled, not crashed).
    const during = h.mgr.snapshot()
    expect(during).not.toBeNull()

    // Outage ends — the next rollover must recover a fresh market and the
    // trigger path must work again end-to-end.
    outage = false
    const recoverySlot = t0 + 51 * SLOT_MS
    vi.setSystemTime(recoverySlot + 1_000)
    h.feed.listener?.()
    await flush(4)
    vi.setSystemTime(recoverySlot + SLOT_MS - 30_000)
    h.feed.setPrices(0.9, 0.05) // ask AT the limit so the paper book can match
    h.feed.listener?.()
    await flush(6)
    h.feed.listener?.() // surface the fill via checkFill on the next tick
    await flush(6)

    const snap = h.mgr.snapshot()!
    expect(snap.executionCount).toBeGreaterThanOrEqual(1) // filled after recovery
  })
})
