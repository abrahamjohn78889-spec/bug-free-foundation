import { randomUUID } from "node:crypto"
import { Wallet } from "ethers"
import {
  AssetType,
  Chain,
  ClobClient,
  COLLATERAL_TOKEN_DECIMALS,
  OrderType,
  Side,
  SignatureTypeV2,
} from "@polymarket/clob-client-v2"
import { env } from "../config"
import { logEvent } from "../events"
import type { LiveAccountOrder, LiveAccountTrade, OpenOrder } from "../types"
import type { Executor, FillReport, OrderState, PlaceOrderRequest } from "./executor"

// ------------------------------------------------------------
// LIVE_V2 pipeline: Polymarket CLOB V2 execution via the official
// @polymarket/clob-client-v2 SDK.
//   - Level 1 signing: EIP-712 order signatures from the vault
//     private key, delegated to the SDK's OrderBuilder.
//   - Level 2 auth: HMAC request headers handled by the SDK from
//     the API key/secret/passphrase creds.
//   - Maker-only (postOnly) GTC resting orders on pUSD collateral.
//   - Numeric precision: price/size are sanitized with toFixed/floor
//     before entering the order block to avoid float rejections.
// ------------------------------------------------------------

/**
 * Parse a Polymarket timestamp that may be a unix-seconds string (e.g.
 * "1700000000") or an ISO date string. Returns epoch ms, or 0 if unparseable.
 */
function parseTsMs(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null) return 0
  const n = Number(raw)
  // A bare number is unix seconds — scale to ms. (10-digit ≈ seconds.)
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n
  const iso = Date.parse(String(raw))
  return Number.isFinite(iso) ? iso : 0
}

// Maker-only: never cross the spread, always provide resting liquidity.
const POST_ONLY = true
// CLOB V2 mandates an explicit tick size in the order options.
const TICK_SIZE = "0.01" as const

/**
 * ethers v6 exposes `signTypedData`, but the SDK's ClobSigner contract expects
 * the ethers v5-style `_signTypedData` plus an async `getAddress()`. This thin
 * adapter bridges a v6 Wallet to that shape without pulling in ethers v5.
 */
class EthersV6SignerAdapter {
  constructor(private readonly wallet: Wallet) {}

  _signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    // ethers v6 strips the EIP712Domain entry itself; pass through as-is.
    return this.wallet.signTypedData(domain as never, types as never, value as never)
  }

  getAddress(): Promise<string> {
    return Promise.resolve(this.wallet.address)
  }
}

export class LiveExecutor implements Executor {
  readonly label = "LIVE_V2"
  private wallet: Wallet
  private client: ClobClient

  constructor() {
    if (
      !env.POLY_PRIVATE_KEY ||
      !env.POLY_PROXY_ADDRESS ||
      !env.POLY_API_KEY ||
      !env.POLY_API_SECRET ||
      !env.POLY_API_PASSPHRASE
    ) {
      throw new Error(
        "LIVE_V2 requires a signing key (WALLET_PRIVATE_KEY/POLY_PRIVATE_KEY), funder (FUNDER_ADDRESS/POLY_PROXY_ADDRESS), and CLOB creds (CLOB_API_KEY/SECRET/PASS_PHRASE).",
      )
    }

    this.wallet = new Wallet(env.POLY_PRIVATE_KEY)
    this.client = new ClobClient({
      host: env.CLOB_HTTP_HOST,
      chain: env.CHAIN_ID as Chain,
      signer: new EthersV6SignerAdapter(this.wallet),
      creds: {
        key: env.POLY_API_KEY,
        secret: env.POLY_API_SECRET,
        passphrase: env.POLY_API_PASSPHRASE,
      },
      signatureType: env.SIGNATURE_TYPE as SignatureTypeV2,
      funderAddress: env.POLY_PROXY_ADDRESS,
    })

    logEvent(
      "info",
      `[LIVE_V2] Live executor armed (SDK). Signer ${this.wallet.address.slice(0, 8)}..., funder ${env.POLY_PROXY_ADDRESS.slice(0, 8)}..., sigType ${env.SIGNATURE_TYPE}`,
    )
  }

  // ---------- numeric sanitation ----------

  /** Sanitize to CLOB V2's expectations: 2dp price, whole-integer shares. */
  private clean(req: PlaceOrderRequest): { price: number; size: number } {
    return { price: Number(req.price.toFixed(2)), size: Math.floor(req.shares) }
  }

  /** Map engine TIF → SDK order type + expiration (unix seconds). */
  private orderTiming(req: PlaceOrderRequest): { orderType: OrderType.GTC | OrderType.GTD; expiration: number } {
    if (req.tif === "GTC") return { orderType: OrderType.GTC, expiration: 0 }
    const secs = req.tif === "1m" ? 60 : 120
    return { orderType: OrderType.GTD, expiration: Math.floor(Date.now() / 1000) + secs }
  }

  // ---------- Executor contract ----------

  async placeOrder(req: PlaceOrderRequest): Promise<OpenOrder> {
    const { price, size } = this.clean(req)
    const { orderType, expiration } = this.orderTiming(req)

    const resp = await this.client.createAndPostOrder(
      { tokenID: req.tokenId, price, side: Side.BUY, size, expiration },
      { tickSize: TICK_SIZE },
      orderType,
      POST_ONLY,
    )

    if (resp && resp.success === false) {
      throw new Error(`CLOB rejected order: ${resp.errorMsg || "unknown error"}`)
    }
    const exchangeOrderId: string | null = resp?.orderID ?? resp?.orderId ?? null
    logEvent(
      "info",
      `[LIVE_V2] Maker order live: ${req.side} ${size} @ $${price.toFixed(2)} (${orderType}, id ${exchangeOrderId})`,
    )

    return {
      clientOrderId: randomUUID(),
      exchangeOrderId,
      marketId: req.marketId,
      tokenId: req.tokenId,
      side: req.side,
      price,
      shares: size,
      placedAtMs: Date.now(),
      phase: req.phase,
    }
  }

  async cancelOrder(order: OpenOrder): Promise<void> {
    if (!order.exchangeOrderId) return
    await this.client.cancelOrder({ orderID: order.exchangeOrderId })
  }

  async cancelReplace(
    order: OpenOrder,
    req: PlaceOrderRequest,
  ): Promise<{ order: OpenOrder; latencyMs: number }> {
    const t0 = performance.now()
    // Cancel the stale order, then post the replacement. DUPLICATE-ORDER
    // SAFETY: if the cancel call fails we must NOT blindly post a second
    // order — the old one may still be resting, which would double exposure.
    // Verify the old order is confirmably dead before placing the new one.
    try {
      await this.cancelOrder(order)
    } catch (e) {
      const state = await this.getOrderState(order)
      if (state === "LIVE" || state === "UNKNOWN") {
        throw new Error(
          `cancel-replace aborted: cancel failed (${(e as Error).message}) and old order state=${state} — refusing to post a duplicate`,
        )
      }
      // DEAD or MATCHED: old order can never rest again; safe to proceed.
      logEvent("warn", `[LIVE_V2] cancel-replace: cancel call failed but order verified ${state} — proceeding with replacement`)
    }
    const next = await this.placeOrder(req)
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10
    return { order: next, latencyMs }
  }

  /** Consecutive checkFill failures — surfaced (throttled) so a persistent
   *  fill-detection outage is never silent. Reset on any successful poll. */
  private fillCheckFailures = 0
  private lastFillCheckWarnMs = 0

  async checkFill(order: OpenOrder): Promise<FillReport | null> {
    if (!order.exchangeOrderId) return null
    try {
      const o = await this.client.getOrder(order.exchangeOrderId)
      this.fillCheckFailures = 0
      if (!o) return null
      const matched = Number(o.size_matched ?? 0)
      const isFullyFilled = o.status === "MATCHED" || matched >= order.shares
      const isPartialFilled = matched > 0 && matched < order.shares
      if (!isFullyFilled && !isPartialFilled) return null

      // PARTIAL-FILL SAFETY: the engine treats any reported fill as terminal
      // for the window, so the unfilled remainder must NEVER stay resting on
      // the book — it would be an orphaned live order that can fill later,
      // untracked. Cancel the remainder BEFORE reporting the partial fill.
      //
      // FILL-DURING-CANCEL RACE: between the getOrder poll above and the
      // cancel below, MORE shares can match. The cancel freezes the order, so
      // the authoritative final count is whatever size_matched reads AFTER
      // the cancel — re-query and report that, or accounting under-counts
      // shares the account actually owns.
      let finalMatched = matched
      if (isPartialFilled) {
        try {
          await this.client.cancelOrder({ orderID: order.exchangeOrderId })
          logEvent(
            "warn",
            `[LIVE_V2] Partial fill ${matched}/${order.shares} on ${order.exchangeOrderId} — remainder cancelled to prevent an orphaned resting order`,
          )
        } catch (e) {
          logEvent(
            "error",
            `[LIVE_V2] Partial fill ${matched}/${order.shares} on ${order.exchangeOrderId} but remainder cancel FAILED: ${(e as Error).message} — manual check advised`,
          )
        }
        // Authoritative post-cancel read. Best-effort: on failure keep the
        // pre-cancel count (never guess upward without exchange truth).
        try {
          const after = await this.client.getOrder(order.exchangeOrderId)
          const afterMatched = Number(after?.size_matched ?? Number.NaN)
          if (Number.isFinite(afterMatched) && afterMatched > finalMatched) {
            logEvent(
              "warn",
              `[LIVE_V2] ${afterMatched - finalMatched} additional share(s) filled during the cancel — reporting final ${afterMatched}/${order.shares}`,
            )
            finalMatched = afterMatched
          }
        } catch {
          /* keep the pre-cancel count — reconciler cross-checks positions */
        }
      }

      // Maker orders fill at their resting limit price; the SDK order record
      // reports that price. Fall back to the engine's recorded price.
      const reported = Number(o.price)
      const filledPrice = Number.isFinite(reported) && reported > 0 ? reported : order.price
      const filledShares = isPartialFilled ? Math.min(finalMatched, order.shares) : order.shares
      const filledOrder = filledShares !== order.shares ? { ...order, shares: filledShares } : order
      return { order: filledOrder, filledPrice }
    } catch (e) {
      // Order not found yet / transient error — treat as "no fill this poll",
      // but surface a persistent outage (fills could be happening unseen).
      this.fillCheckFailures++
      const now = Date.now()
      if (this.fillCheckFailures >= 5 && now - this.lastFillCheckWarnMs > 30_000) {
        this.lastFillCheckWarnMs = now
        logEvent(
          "warn",
          `[LIVE_V2] checkFill has failed ${this.fillCheckFailures}x consecutively (${(e as Error).message}) — fills may be undetected until the API recovers`,
        )
      }
      return null
    }
  }

  /** Exchange-truth order state, for stuck-RESTING detection and safe replace. */
  async getOrderState(order: OpenOrder): Promise<OrderState> {
    if (!order.exchangeOrderId) return "UNKNOWN"
    try {
      const o = await this.client.getOrder(order.exchangeOrderId)
      if (!o) return "DEAD"
      const status = String(o.status ?? "").toUpperCase()
      const matched = Number(o.size_matched ?? 0)
      if (status === "MATCHED" || matched >= order.shares) return "MATCHED"
      if (status === "LIVE" || status === "DELAYED" || status === "OPEN") return "LIVE"
      if (status === "CANCELED" || status === "CANCELLED" || status === "EXPIRED" || status === "UNMATCHED") return "DEAD"
      return "UNKNOWN"
    } catch (e) {
      const msg = (e as Error).message || ""
      // A definitive 404 means the order no longer exists on the book.
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) return "DEAD"
      return "UNKNOWN"
    }
  }

  // ---------- live-only extensions ----------

  /** Purge EVERY resting order on the book (used at slot rollover). */
  async cancelAllOrders(): Promise<void> {
    await this.client.cancelAll()
    logEvent("info", "[LIVE_V2] cancelAll issued — purged resting orders at slot rollover")
  }

  /** Available USDC collateral in dollars, for the dashboard. */
  async getAvailableBalanceUsd(): Promise<number | null> {
    try {
      const r = await this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
      const raw = Number(r?.balance ?? 0)
      if (!Number.isFinite(raw)) return null
      return raw / 10 ** COLLATERAL_TOKEN_DECIMALS
    } catch (err) {
      logEvent("warn", `[LIVE_V2] balance query failed: ${(err as Error).message}`)
      return null
    }
  }

  /** Resting open orders on the account, mapped to the dashboard shape. */
  async getOpenOrdersLive(): Promise<LiveAccountOrder[]> {
    // only_first_page=true keeps this to a single lightweight request.
    const rows = await this.client.getOpenOrders(undefined, true)
    if (!Array.isArray(rows)) return []
    return rows.map((o) => ({
      id: String(o.id),
      market: String(o.market ?? ""),
      assetId: String(o.asset_id ?? ""),
      outcome: String(o.outcome ?? ""),
      side: String(o.side ?? ""),
      price: Number(o.price ?? 0),
      originalSize: Number(o.original_size ?? 0),
      sizeMatched: Number(o.size_matched ?? 0),
      orderType: String(o.order_type ?? ""),
      // CLOB reports created_at in seconds; normalize to ms.
      createdAtMs: parseTsMs(o.created_at),
    }))
  }

  /** Recent trades/fills on the account, mapped to the dashboard shape. */
  async getRecentTradesLive(): Promise<LiveAccountTrade[]> {
    const rows = await this.client.getTrades(undefined, true)
    if (!Array.isArray(rows)) return []
    return rows.map((t) => ({
      id: String(t.id),
      market: String(t.market ?? ""),
      assetId: String(t.asset_id ?? ""),
      outcome: String(t.outcome ?? ""),
      side: String(t.side ?? ""),
      price: Number(t.price ?? 0),
      size: Number(t.size ?? 0),
      status: String(t.status ?? ""),
      traderSide: String(t.trader_side ?? ""),
      matchTimeMs: parseTsMs(t.match_time),
      txHash: t.transaction_hash ?? null,
    }))
  }

  /** Funder/proxy/deposit address the account trades from. */
  getFunderAddress(): string | null {
    return env.POLY_PROXY_ADDRESS || null
  }
}
