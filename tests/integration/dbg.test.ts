import { describe, it, expect, vi, afterEach, beforeAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { StandingOrderManager } from "@/lib/v2/engine/standing-order"
import { RiskManager } from "@/lib/v2/engine/risk"
import type { Bankroll } from "@/lib/v2/engine/bankroll"
import type { ClobPriceFeed } from "@/lib/v2/engine/feeds/clob-price-feed"
import type { BtcReferenceFeed } from "@/lib/v2/engine/feeds/btc-reference-feed"
import type { MarketDiscovery, DiscoveredMarket } from "@/lib/v2/engine/feeds/market-discovery"
import { FakeClobFeed } from "../helpers/fake-clob-feed"

function makeMarket(slotEndMs: number): DiscoveredMarket {
  return { slotEndMs, slug:`m-${slotEndMs}`, question:"?", conditionId:"0x", upTokenId:"up", downTokenId:"dn", orderMinSize:5, tickSize:0.01, active:true, closed:false, volumeUsd:null, liquidityUsd:null, endDateIso:null }
}
const SLOT = 5*60_000

beforeAll(() => {
  const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || "data/test-ledger.db")
  for (const s of ["","-wal","-shm"]) { try { fs.rmSync(dbPath+s, { force:true }) } catch {} }
})

describe("dbg", () => {
  it("trace", async () => {
    const feed = new FakeClobFeed()
    let spotPrice = 100_000
    const bankroll = { balance: 1000, dustReserve: 0, debitFixed(c:number){ this.balance -= c } }
    const spotFeed = { get latest() { return { price: spotPrice, tsMs: Date.now(), source:"chainlink-onchain" as const } }, onTick:()=>()=>{}, start(){}, stop(){} } as unknown as BtcReferenceFeed
    const discovery = { peek:(s:number)=>makeMarket(s), resolve:async(s:number)=>makeMarket(s), refreshMarket:async(s:number)=>makeMarket(s), fetchResolution:async()=>null } as unknown as MarketDiscovery
    const mgr = new StandingOrderManager({ getMode:()=>"PAPER_V1", getBankroll:()=>bankroll as unknown as Bankroll, discovery, clobPriceFeed: feed as unknown as ClobPriceFeed, spotFeed, risk: new RiskManager(()=>"PAPER_V1") })
    const slotStart = Math.ceil(Date.now()/SLOT)*SLOT + SLOT
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(slotStart + 1000)

    feed.setPrices(0.5, 0.5)
    mgr.arm(0.99, 5, 5, 0.01, 0.99, 0.98, "AT_OR_ABOVE")
    for (let i=0;i<10;i++) await new Promise(r=>setTimeout(r,0))
    console.log("after arm", JSON.stringify({exec: mgr.snapshot()?.executionCount, status: mgr.snapshot()?.status, locked: mgr.snapshot()?.lockedDirection}))

    spotPrice = 100_200
    feed.listener?.()
    for (let i=0;i<10;i++) await new Promise(r=>setTimeout(r,0))
    console.log("tick1", JSON.stringify({exec: mgr.snapshot()?.executionCount, locked: mgr.snapshot()?.lockedDirection, status: mgr.snapshot()?.status, openCount: mgr.snapshot()?.openPositionCount}))

    feed.setPrices(0.4, 0.99)
    feed.listener?.()
    for (let i=0;i<10;i++) await new Promise(r=>setTimeout(r,0))
    console.log("tick2", JSON.stringify({exec: mgr.snapshot()?.executionCount, locked: mgr.snapshot()?.lockedDirection, status: mgr.snapshot()?.status, openCount: mgr.snapshot()?.openPositionCount, restingSide: mgr.snapshot()?.restingSide}))

    feed.setPrices(0.98, 0.4)
    feed.listener?.()
    for (let i=0;i<20;i++) await new Promise(r=>setTimeout(r,0))
    const s = mgr.snapshot()!
    console.log("tick3", JSON.stringify({exec:s.executionCount, locked:s.lockedDirection, status:s.status, openCount:s.openPositionCount, restingSide:s.restingSide, openPosition:s.openPosition}))
    mgr.dispose()
    vi.useRealTimers()
    expect(true).toBe(true)
  })
})
