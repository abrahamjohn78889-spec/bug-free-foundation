import type { LiveAccountOrder, LiveAccountTrade, OpenOrder, TIF, TradeSide } from "../types"

// ------------------------------------------------------------
// Hot-swappable execution pipeline interface.
// PAPER_V1 and LIVE_V2 both implement this contract so the
// strategy layer never knows which environment it runs in.
// ------------------------------------------------------------

export interface PlaceOrderRequest {
  marketId: string
  tokenId: string
  side: TradeSide
  price: number
  shares: number
  phase: OpenOrder["phase"]
  /** Time-In-Force: "1m", "2m", or "GTC" */
  tif: TIF
  /**
   * Unix epoch ms at which the engine will auto-cancel this order
   * if still unfilled. Computed from tif at placement time.
   * null means GTC — no engine-side expiry timer.
   */
  expireAtMs: number | null
  /**
   * Bug #009: whether the LIVE_V2 executor may submit this order as a taker.
   *  • Default (undefined / true) → post-only maker rest, rejected by CLOB
   *    if it would cross the spread. Safe for cancel-replace / re-quote flows.
   *  • false → allow immediate matching. The standing-order pipeline sets this
   *    when the trigger has fired, because its semantic is "buy at limit price
   *    now that the ask reached the trigger" — post-only would reject the
   *    marketable order and the trigger would never fill.
   * PAPER_V1 ignores this field (paper simulates fills from the live ask).
   */
  postOnly?: boolean
}


export interface FillReport {
  order: OpenOrder
  filledPrice: number
}

/**
 * Exchange-truth state of a previously-placed order.
 *  - LIVE:    resting on the book (possibly partially matched)
 *  - MATCHED: fully filled
 *  - DEAD:    cancelled/expired/not found — will never fill again
 *  - UNKNOWN: state could not be determined (network/API failure)
 */
export type OrderState = "LIVE" | "MATCHED" | "DEAD" | "UNKNOWN"

export interface Executor {
  readonly label: string
  /** Place a resting limit maker order (GTC, post-only semantics). */
  placeOrder(req: PlaceOrderRequest): Promise<OpenOrder>
  /** Cancel a resting order. Must be fast — part of the <100ms loop. */
  cancelOrder(order: OpenOrder): Promise<void>
  /** Atomic cancel + replace, latency-tracked. Returns the new order. */
  cancelReplace(order: OpenOrder, req: PlaceOrderRequest): Promise<{ order: OpenOrder; latencyMs: number }>
  /** Poll whether a resting order has filled. */
  checkFill(order: OpenOrder): Promise<FillReport | null>
  /**
   * Optional (LIVE_V2 only): query the exchange-truth state of an order.
   * Used to detect externally-cancelled resting orders (stuck-RESTING guard)
   * and to verify an order is dead before posting a replacement.
   */
  getOrderState?(order: OpenOrder): Promise<OrderState>
  /**
   * Optional (LIVE_V2 only): cancel EVERY resting order on the book in one
   * call. Used at slot rollover to purge stale unfilled maker orders. Paper
   * does not implement this.
   */
  cancelAllOrders?(): Promise<void>
  /**
   * Optional (LIVE_V2 only): fetch the wallet's available USDC collateral
   * balance in dollars, for display on the dashboard. Returns null if it
   * cannot be read. Paper does not implement this.
   */
  getAvailableBalanceUsd?(): Promise<number | null>
  /**
   * Optional (LIVE_V2 only): resting open orders on the authenticated account,
   * mapped to the display shape. Read-only; used for the dashboard mirror.
   */
  getOpenOrdersLive?(): Promise<LiveAccountOrder[]>
  /**
   * Optional (LIVE_V2 only): recent trades/fills on the authenticated account,
   * mapped to the display shape. Read-only; used for the dashboard mirror.
   */
  getRecentTradesLive?(): Promise<LiveAccountTrade[]>
  /**
   * Optional (LIVE_V2 only): the funder/proxy/deposit address the account
   * trades from. Used both for display and to key the public Data API.
   */
  getFunderAddress?(): string | null
  /**
   * Optional (PAPER_V1 only): credit a settlement payout (WIN payout or
   * SCRATCH cost refund) back to the simulated wallet. The wallet is debited
   * on every fill, so WITHOUT this credit it drains monotonically over a long
   * paper session until orders are rejected for "not enough balance" and the
   * reconciler reports growing phantom drift. Live settlements credit the real
   * wallet on-chain, so LiveExecutor does not implement it.
   */
  creditSettlement?(usd: number): void

  /**
   * PAPER-ONLY authority seam (Phase 5): re-seed the simulated wallet mirror
   * FROM the ledger-driven bankroll. The sim wallet is in-memory and resets on
   * restart; the engine pushes the authoritative pool into it at boot and on
   * every rollover sync so the mirror can never overwrite the true balance.
   * LiveExecutor does not implement it — the real wallet cannot be written.
   */
  setWalletUsd?(usd: number): void
}
