import { afterEach, beforeAll, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { StandingOrderManager } from "@/lib/v2/engine/standing-order"
import { RiskManager } from "@/lib/v2/engine/risk"
import type { Bankroll } from "@/lib/v2/engine/bankroll"
import type { ClobPriceFeed } from "@/lib/v2/engine/feeds/clob-price-feed"
import type { BtcReferenceFeed } from "@/lib/v2/engine/feeds/btc-reference-feed"
import type { MarketDiscovery, DiscoveredMarket } from "@/lib/v2/engine/feeds/market-discovery"
import { FakeClobFeed } from "../helpers/fake-clob-feed"

// ---------------------------------------------------------------------------
// BUG #5 — Compounding staleness gate
//
// rolloverSlot dispatches settleOfficial asynchronously. Before the fix, a
// PERCENT-mode trigger in the NEW slot could size against a stale bankroll
// while the previous slot's payout was still in flight. The fix tracks the
// tradeUids of positions awaiting settlement and withholds the next PERCENT
// order (status WAITING_SETTLE) until every one is credited.
// ---------------------------------------------------------------------------

function makeMarket(slotEndMs: number): DiscoveredMarket {
  return {
    slotEndMs,
    slug: `btc-updown-5m-bug5-${slotEndMs}`,
    question: "BTC up or down?",
    conditionId: "0xcond5",
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
async function flush(times = 4) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeAll(() => {
  const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || "data/test-ledger.db")
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(dbPath + suffix, { force: true }) } catch { /* ignore */ }
  }
})

afterEach(() => { while (live.length) live.pop()!.dispose() })

function harness() {
  const feed = new FakeClobFeed()
  const bankroll = {
    balance: 1000,
    dustReserve: 0,
    debitFixed(c: number) { this.balance -= c },
    settle(payout: number) { this.balance += payout },
  }
  const spotFeed = {
    get latest() { return { price: 100_000, tsMs: Date.now(), source: "chainlink-onchain" as const } },
    onTick: () => () => {}, start() {}, stop() {},
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

describe("BUG #5 — PERCENT compounding waits for prior settlements", () => {
  it("withholds a PERCENT trigger while a previous lot is still pending settlement (WAITING_SETTLE)", async () => {
    const h = harness()
    h.feed.setPrices(0.9, 0.2)
    const msg = h.mgr.arm(0.9, 0, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { sizingMode: "PERCENT", sizeValue: 10 })
    expect(msg).toContain("armed")
    await flush()
    // Simulate the exact hand-off `rolloverSlot` performs before the async
    // `settleOfficial` credits the pool: a prior tradeUid is registered as
    // pending. The next PERCENT trigger must refuse to size from stale money.
    ;(h.mgr as unknown as { pendingSettlementUids: Set<string> }).pendingSettlementUids.add("uid-prior-slot")

    // Re-arm the manager to represent the new slot and drive a trigger tick.
    h.mgr.arm(0.9, 0, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { sizingMode: "PERCENT", sizeValue: 10 })
    await flush()

    const s = h.mgr.snapshot()!
    expect(s.status).toBe("WAITING_SETTLE")
    expect(s.openPositionCount).toBe(0)
  })

  it("clears the gate when the pending lot settles, allowing the next PERCENT order to fire", async () => {
    const h = harness()
    h.feed.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 0, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { sizingMode: "PERCENT", sizeValue: 10 })
    await flush()
    const pending = (h.mgr as unknown as { pendingSettlementUids: Set<string> }).pendingSettlementUids
    pending.add("uid-prior-slot")

    // Simulate settlement completing (recordSettlement deletes the uid).
    pending.delete("uid-prior-slot")

    h.mgr.arm(0.9, 0, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE", { sizingMode: "PERCENT", sizeValue: 10 })
    await flush()
    const s = h.mgr.snapshot()!
    expect(s.openPosition?.shares).toBeGreaterThan(0)
  })

  it("does NOT gate FIXED_SHARES (share count independent of bankroll)", async () => {
    const h = harness()
    h.feed.setPrices(0.9, 0.2)
    ;(h.mgr as unknown as { pendingSettlementUids: Set<string> }).pendingSettlementUids.add("uid-prior-slot")
    h.mgr.arm(0.9, 7, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    const s = h.mgr.snapshot()!
    expect(s.openPosition?.shares).toBe(7)
  })

  it("FIXED_SHARES trigger returns the SAME configured count across repeated executions (no silent variance)", async () => {
    const h = harness()
    h.feed.setPrices(0.9, 0.2)
    h.mgr.arm(0.9, 7, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    const first = h.mgr.snapshot()!.openPosition?.shares
    // Simulate the manager returning to an ARMED state for the next slot
    // without changing the configured params.
    h.mgr.arm(0.9, 7, 5, 0.01, 0.99, 0.9, "AT_OR_ABOVE")
    await flush()
    const second = h.mgr.snapshot()!.openPosition?.shares
    expect(first).toBe(7)
    expect(second).toBe(7)
  })
})
