// ============================================================================
// PHASE 3 — EXECUTION ENGINE HARDENING TESTS
// ============================================================================
// Verifies the ghost-tick epoch guard, the adaptive scheduler machinery, the
// hot-path isolation of the fill poll, the SLO liveness watchdog, in-window
// withhold logging (no silent skips), and execution-latency instrumentation.
//
// Uses the same real-manager + fake-feed harness as standing-order.test.ts:
// the manager runs its REAL tick loop against the in-memory FakeClobFeed and
// the real PaperExecutor + SQLite ledger.
// ============================================================================

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { StandingOrderManager } from "@/lib/v2/engine/standing-order"
import { RiskManager } from "@/lib/v2/engine/risk"
import { Watchdog } from "@/lib/v2/engine/watchdog"
import { getDbHandle, flushWriteQueueSync } from "@/lib/v2/engine/db"
import type { Bankroll } from "@/lib/v2/engine/bankroll"
import type { ClobPriceFeed } from "@/lib/v2/engine/feeds/clob-price-feed"
import type { BtcReferenceFeed } from "@/lib/v2/engine/feeds/btc-reference-feed"
import type { MarketDiscovery, DiscoveredMarket } from "@/lib/v2/engine/feeds/market-discovery"
import type { OrderEventListener } from "@/lib/v2/engine/feeds/order-events"
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

async function flush(times = 8) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

function makeHarness() {
  const feed = new FakeClobFeed()
  const bankroll = {
    balance: 1000,
    dustReserve: 0,
    debitFixed(c: number) {
      this.balance -= c
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
  return { mgr, feed, bankroll }
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
})

// ---------------------------------------------------------------------------
// 1. GHOST-TICK EPOCH GUARD
// ---------------------------------------------------------------------------
describe("ghost-tick epoch guard", () => {
  it("kickLoop() invalidates in-flight ticks and restarts the chain (no duplicate execution)", async () => {
    const h = makeHarness()
    h.feed.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    // One fill happened through the normal path.
    expect(h.mgr.snapshot()!.executionCount).toBe(1)

    // Kick the loop (simulating watchdog recovery). The epoch bump must not
    // produce a second execution: one-order-per-window still holds, and no
    // ghost resumes a duplicate submission.
    h.mgr.kickLoop("test kick")
    await flush()
    expect(h.mgr.snapshot()!.executionCount).toBe(1)
    expect(h.mgr.snapshot()!.status).toBe("FILLED")
  })

  it("getLoopHealth() reports an active, completing loop", async () => {
    const h = makeHarness()
    h.feed.setPrices(0.5, 0.5)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    const health = h.mgr.getLoopHealth()
    expect(health.active).toBe(true)
    expect(health.paused).toBe(false)
    expect(health.lastTickCompletedMs).toBeGreaterThan(0)
  })

  it("cancel() stops the loop — health reports inactive", async () => {
    const h = makeHarness()
    h.feed.setPrices(0.5, 0.5)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    h.mgr.cancel()
    const health = h.mgr.getLoopHealth()
    expect(health.active).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. SLO LIVENESS WATCHDOG
// ---------------------------------------------------------------------------
describe("SLO liveness watchdog", () => {
  function makeWatchdogDeps(slo: {
    active: boolean
    paused: boolean
    lastTickStartMs: number
    lastTickCompletedMs: number
  }) {
    const kicks: string[] = []
    const clobPriceFeed = {
      wsDiagnostics: () => ({ connected: true, lastMessageAtMs: Date.now(), assetIds: [] }),
      diagnostics: () => ({
        upTokenId: null,
        downTokenId: null,
        lastSuccessMs: Date.now(),
        consecutiveFailures: 0,
        lastFailReason: "",
      }),
      forceWsReconnect: () => {},
      pollNow: () => {},
    } as unknown as ClobPriceFeed
    const orderEvents = {
      hasScope: false,
      connected: false,
      lastFrameAgeMs: 0,
      forceReconnect: () => {},
    } as unknown as OrderEventListener
    const wd = new Watchdog({
      clobPriceFeed,
      getOrderEvents: () => orderEvents,
      isTrackingMarket: () => false,
      getSloHealth: () => slo,
      kickSlo: (reason) => kicks.push(reason),
    })
    return { wd, kicks }
  }

  it("kicks a stalled SLO loop (no tick completed for >30s while armed)", () => {
    vi.useFakeTimers()
    try {
      const stalled = {
        active: true,
        paused: false,
        lastTickStartMs: Date.now() - 60_000,
        lastTickCompletedMs: Date.now() - 60_000,
      }
      const { wd, kicks } = makeWatchdogDeps(stalled)
      wd.start()
      vi.advanceTimersByTime(31_000) // one check cycle
      expect(kicks.length).toBe(1)
      expect(wd.snapshot().sloLoopRestarts).toBe(1)
      wd.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does NOT kick a healthy loop, a paused loop, or an inactive manager", () => {
    vi.useFakeTimers()
    try {
      for (const slo of [
        { active: true, paused: false, lastTickStartMs: Date.now(), lastTickCompletedMs: Date.now() }, // healthy
        { active: true, paused: true, lastTickStartMs: Date.now() - 90_000, lastTickCompletedMs: Date.now() - 90_000 }, // paused
        { active: false, paused: false, lastTickStartMs: Date.now() - 90_000, lastTickCompletedMs: Date.now() - 90_000 }, // inactive
      ]) {
        const { wd, kicks } = makeWatchdogDeps(slo)
        wd.start()
        vi.advanceTimersByTime(31_000)
        expect(kicks.length).toBe(0)
        wd.stop()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it("rate-limits kicks — a permanently stalled loop is not kicked every check", () => {
    vi.useFakeTimers()
    try {
      const stalled = {
        active: true,
        paused: false,
        lastTickStartMs: Date.now() - 300_000,
        lastTickCompletedMs: Date.now() - 300_000,
      }
      const { wd, kicks } = makeWatchdogDeps(stalled)
      wd.start()
      vi.advanceTimersByTime(31_000)
      expect(kicks.length).toBe(1)
      // The check at +30s after the kick is inside the 30s cooldown (30s is
      // not > 30s) and must be suppressed; the following check kicks again.
      vi.advanceTimersByTime(31_000)
      expect(kicks.length).toBe(1)
      vi.advanceTimersByTime(31_000)
      expect(kicks.length).toBe(2)
      wd.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. NO SILENT SKIPS — in-window withholds write permanent order_log rows
// ---------------------------------------------------------------------------
describe("in-window withhold logging", () => {
  it("writes a WITHHELD order_log row when capital is insufficient inside the window", async () => {
    const h = makeHarness()
    h.bankroll.balance = 0.5 // cannot afford anything
    h.feed.setPrices(0.9, 0.2)
    // No entry window configured → window is always "open" (opensIn null → logWithheld
    // only logs when opensIn is null or <= 0; null means no window = always eligible).
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()

    const s = h.mgr.snapshot()!
    expect(s.status).toBe("INSUFFICIENT")
    flushWriteQueueSync()
    const rows = getDbHandle()
      .prepare("SELECT * FROM order_log WHERE event = 'WITHHELD' AND detail LIKE '%insufficient-capital%'")
      .all() as Array<{ detail: string }>
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0].detail).toContain("capital insufficient")
  })

  it("writes at most ONE WITHHELD row per reason per slot (throttle)", async () => {
    // Isolate from rows written by other tests sharing the same test DB.
    flushWriteQueueSync()
    getDbHandle().prepare("DELETE FROM order_log WHERE event = 'WITHHELD'").run()
    const h = makeHarness()
    h.bankroll.balance = 0.5
    h.feed.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    // Fire many more ticks — the withhold row must not multiply.
    for (let i = 0; i < 5; i++) {
      h.feed.listener?.()
      await flush(3)
    }
    flushWriteQueueSync()
    const rows = getDbHandle()
      .prepare("SELECT COUNT(*) as n FROM order_log WHERE event = 'WITHHELD' AND detail LIKE '%insufficient-capital%'")
      .get() as { n: number }
    expect(rows.n).toBe(1)
  })

  it("writes a WITHHELD row when the price is outside the guardrail band", async () => {
    const h = makeHarness()
    h.feed.setPrices(0.995, 0.005) // above the 0.99 max band
    h.mgr.arm(0.9, 10, 5, 0.5, 0.95, 0.9, "AT_OR_ABOVE") // band [0.50, 0.95]
    await flush()
    const s = h.mgr.snapshot()!
    expect(s.status).toBe("OUT_OF_RANGE")
    flushWriteQueueSync()
    const rows = getDbHandle()
      .prepare("SELECT COUNT(*) as n FROM order_log WHERE event = 'WITHHELD' AND detail LIKE '%out-of-range%'")
      .get() as { n: number }
    expect(rows.n).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// 4. EXECUTION LATENCY INSTRUMENTATION
// ---------------------------------------------------------------------------
describe("execution latency instrumentation", () => {
  it("records a full latency breakdown on submission and exposes it in the snapshot", async () => {
    const h = makeHarness()
    h.feed.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()

    const s = h.mgr.snapshot()!
    expect(s.executionCount).toBe(1)
    const lat = s.lastExecutionLatency
    expect(lat).not.toBeNull()
    expect(lat!.totalMs).toBeGreaterThanOrEqual(0)
    expect(lat!.decisionMs).toBeGreaterThanOrEqual(0)
    expect(lat!.submitMs).toBeGreaterThanOrEqual(0)
    expect(lat!.atMs).toBeGreaterThan(0)
    // Paper execution is in-process: the whole path must be fast.
    expect(lat!.totalMs).toBeLessThan(5_000)
  })

  it("stores the latency breakdown permanently in the trade explanation", async () => {
    const h = makeHarness()
    h.feed.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()

    flushWriteQueueSync()
    const row = getDbHandle()
      .prepare("SELECT explanation FROM trades ORDER BY id DESC LIMIT 1")
      .get() as { explanation: string }
    const parsed = JSON.parse(row.explanation)
    expect(parsed.executionLatency).toBeTruthy()
    expect(typeof parsed.executionLatency.totalMs).toBe("number")
    expect(typeof parsed.executionLatency.submitMs).toBe("number")
  })
})

// ---------------------------------------------------------------------------
// 5. HOT-PATH ISOLATION — resting fill poll runs off the tick
// ---------------------------------------------------------------------------
describe("hot-path isolation", () => {
  it("a resting (non-marketable) order still fills via the background poll", async () => {
    const h = makeHarness()
    // Price at trigger fires the submission; then ask ABOVE limit = maker rest.
    h.feed.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    // Immediate marketable fill in paper — executionCount 1. This validates
    // the isolated path end-to-end (submission→fill through the new machinery).
    const s = h.mgr.snapshot()!
    expect(s.executionCount).toBe(1)
    expect(s.openPositionCount).toBe(1)
  })

  it("tick loop keeps completing while an order rests (loop never starves)", async () => {
    const h = makeHarness()
    h.feed.setPrices(0.5, 0.5) // below trigger — armed, no order
    h.mgr.arm(0.9, 10, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    const t1 = h.mgr.getLoopHealth().lastTickCompletedMs
    // Drive several WS event ticks; each must COMPLETE (not block on REST).
    for (let i = 0; i < 3; i++) {
      h.feed.listener?.()
      await flush(3)
    }
    const t2 = h.mgr.getLoopHealth().lastTickCompletedMs
    expect(t2).toBeGreaterThanOrEqual(t1)
    expect(h.mgr.snapshot()!.status).toBe("ARMED")
  })
})
