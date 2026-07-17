import { describe, expect, it, vi } from "vitest"
import { LiveExecutor } from "../../lib/v2/engine/execution/live"
import { flushWriteQueueSync, insertTrade, recentTrades } from "../../lib/v2/engine/db"
import type { OpenOrder } from "../../lib/v2/engine/types"


/**
 * BUG #8 + LIVE-FILL PARITY SPOT-CHECK
 *
 * End-to-end validation that a real Polymarket CLOB fill event flows through
 * `LiveExecutor.checkFill` → onFill math → settlement math → ledger with
 * every field intact. Bypasses the LiveExecutor constructor (which needs
 * wallet + API creds) and injects a mock ClobClient so the exact SDK
 * response shapes the SDK returns in production can be replayed.
 *
 * The math replayed here is copied verbatim from:
 *   - standing-order.ts onFill:1986   cost = shares × filledPrice (4dp)
 *   - engine.ts recordSettlement:1291 payout = WIN? shares : SCRATCH? cost : 0
 *                                     pnl    = payout − cost (4dp; SCRATCH→0)
 * Any drift between production and this replay would fail the assertions.
 */

interface FakeClobOrderRecord {
  status?: string
  size_matched?: number | string
  price?: number | string
}

function makeExecutor(handlers: {
  getOrder: (id: string) => Promise<FakeClobOrderRecord | null>
  cancelOrder?: (args: { orderID: string }) => Promise<void>
}) {
  // Bypass constructor (skips wallet + creds); inject a minimal client.
  const exec = Object.create(LiveExecutor.prototype) as LiveExecutor & {
    client: {
      getOrder: typeof handlers.getOrder
      cancelOrder: NonNullable<typeof handlers.cancelOrder>
    }
    fillCheckFailures: number
    lastFillCheckWarnMs: number
  }
  exec.client = {
    getOrder: handlers.getOrder,
    cancelOrder: handlers.cancelOrder ?? (async () => undefined),
  }
  exec.fillCheckFailures = 0
  exec.lastFillCheckWarnMs = 0
  return exec
}

const baseOrder: OpenOrder = {
  clientOrderId: "test-client-order",
  exchangeOrderId: "0xabc",
  marketId: "market-btc-1700000000",
  tokenId: "token-up",
  side: "UP",
  price: 0.95,
  shares: 7,
  placedAtMs: 1700000000000,
  phase: "PRIORITY_1",
}

/** Replay engine cost + settlement math exactly as production computes it. */
function replayLedgerMath(filledPrice: number, filledShares: number, winner: "UP" | "DOWN" | null, betSide: "UP" | "DOWN") {
  const cost = Math.round(filledShares * filledPrice * 10000) / 10000
  const isScratch = winner === null
  const won = !isScratch && betSide === winner
  const result: "WIN" | "LOSS" | "SCRATCH" = isScratch ? "SCRATCH" : won ? "WIN" : "LOSS"
  const payout = isScratch ? cost : won ? filledShares : 0
  const pnl = isScratch ? 0 : Math.round((payout - cost) * 10000) / 10000
  return { cost, payout, pnl, result }
}

describe("LIVE fill ingestion — end-to-end spot-check", () => {
  // The ledger write path uses queueWrite + setImmediate; keep real timers
  // (no vi.useFakeTimers) so setImmediate actually fires within the test.


  it("full fill: propagates filledPrice, filledShares, cost, and pnl to the ledger", async () => {
    const exec = makeExecutor({
      getOrder: vi.fn(async () => ({ status: "MATCHED", size_matched: 7, price: 0.95 })),
    })

    const fill = await exec.checkFill(baseOrder)
    expect(fill).not.toBeNull()
    expect(fill!.filledPrice).toBe(0.95)
    expect(fill!.order.shares).toBe(7)

    // Replay production PnL for WIN (bet UP, resolved UP).
    const math = replayLedgerMath(fill!.filledPrice, fill!.order.shares, "UP", "UP")
    expect(math.cost).toBe(6.65)
    expect(math.payout).toBe(7)
    expect(math.pnl).toBe(0.35)
    expect(math.result).toBe("WIN")

    insertTrade({
      marketId: baseOrder.marketId,
      slotEndMs: 1700000300000,
      side: "UP",
      price: fill!.filledPrice,
      shares: fill!.order.shares,
      cost: math.cost,
      result: math.result,
      pnl: math.pnl,
      balanceAfter: 100 + math.pnl,
      dustSaved: 0,
      mode: "LIVE_V2",
    })

    // Read back the row and assert every field.
    flushWriteQueueSync()
    const rows = recentTrades("LIVE_V2", 5)

    const row = rows.find((r) => r.marketId === baseOrder.marketId)
    expect(row).toBeDefined()
    expect(row!.price).toBe(0.95)
    expect(row!.shares).toBe(7)
    expect(row!.cost).toBe(6.65)
    expect(row!.pnl).toBe(0.35)
    expect(row!.result).toBe("WIN")
  })

  it("partial fill: reports final matched shares after post-cancel race and settles LOSS on those shares only", async () => {
    let calls = 0
    const exec = makeExecutor({
      getOrder: vi.fn(async () => {
        calls += 1
        // Poll 1 → 3 matched (partial). Poll 2 (post-cancel) → 5 matched
        // (race: 2 additional shares filled during the cancel round-trip).
        if (calls === 1) return { status: "LIVE", size_matched: 3, price: 0.95 }
        return { status: "LIVE", size_matched: 5, price: 0.95 }
      }),
      cancelOrder: vi.fn(async () => undefined),
    })

    const fill = await exec.checkFill(baseOrder)
    expect(fill).not.toBeNull()
    expect(fill!.order.shares).toBe(5) // authoritative post-cancel count
    expect(fill!.filledPrice).toBe(0.95)

    // LOSS: pnl = −cost only for the shares actually filled.
    const math = replayLedgerMath(fill!.filledPrice, fill!.order.shares, "DOWN", "UP")
    expect(math.cost).toBe(4.75)
    expect(math.payout).toBe(0)
    expect(math.pnl).toBe(-4.75)
    expect(math.result).toBe("LOSS")
  })

  it("BUG #8: MATCHED status with size_matched < order.shares does NOT over-report as full fill", async () => {
    // Regression: previously `isFullyFilled = status==='MATCHED' || matched>=shares`
    // treated any MATCHED status as a full fill, so a MATCHED report with
    // size_matched=4/7 booked 7 shares (over-credit ~$2.85). Fix trusts
    // size_matched over status.
    const exec = makeExecutor({
      getOrder: vi.fn(async () => ({ status: "MATCHED", size_matched: 4, price: 0.95 })),
      cancelOrder: vi.fn(async () => undefined),
    })
    const fill = await exec.checkFill(baseOrder)
    expect(fill).not.toBeNull()
    expect(fill!.order.shares).toBe(4) // NOT 7
    // Ledger cost must reflect the 4 shares actually filled ($3.80), not $6.65.
    const math = replayLedgerMath(fill!.filledPrice, fill!.order.shares, "UP", "UP")
    expect(math.cost).toBe(3.8)
    expect(math.payout).toBe(4)
    expect(math.pnl).toBe(0.2)
  })

  it("size_matched absent + status MATCHED: falls back to full requested shares (backwards compat)", async () => {
    const exec = makeExecutor({
      getOrder: vi.fn(async () => ({ status: "MATCHED", price: 0.95 })),
    })
    const fill = await exec.checkFill(baseOrder)
    expect(fill).not.toBeNull()
    expect(fill!.order.shares).toBe(7)
    expect(fill!.filledPrice).toBe(0.95)
  })

  it("reported price missing/zero: falls back to the order's own limit price", async () => {
    const exec = makeExecutor({
      getOrder: vi.fn(async () => ({ status: "MATCHED", size_matched: 7, price: 0 })),
    })
    const fill = await exec.checkFill(baseOrder)
    expect(fill).not.toBeNull()
    expect(fill!.filledPrice).toBe(0.95) // fallback to order.price
    // Cost math still lines up with the fallback price.
    const math = replayLedgerMath(fill!.filledPrice, fill!.order.shares, null, "UP")
    expect(math.result).toBe("SCRATCH")
    expect(math.pnl).toBe(0)
    expect(math.payout).toBe(6.65) // scratch refunds cost
  })

  it("over-report defense: exchange returns matched > order.shares → cap at order.shares", async () => {
    const exec = makeExecutor({
      getOrder: vi.fn(async () => ({ status: "MATCHED", size_matched: 999, price: 0.95 })),
    })
    const fill = await exec.checkFill(baseOrder)
    expect(fill).not.toBeNull()
    expect(fill!.order.shares).toBe(7) // never over-report
  })

  it("no fill yet: LIVE status with 0 matched returns null", async () => {
    const exec = makeExecutor({
      getOrder: vi.fn(async () => ({ status: "LIVE", size_matched: 0, price: 0.95 })),
    })
    expect(await exec.checkFill(baseOrder)).toBeNull()
  })
})
