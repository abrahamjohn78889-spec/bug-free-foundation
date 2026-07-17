import { randomUUID } from "node:crypto"
import { env } from "../config"
import { logEvent } from "../events"
import type { LiveAccountOrder, LiveAccountTrade, OpenOrder, TradeSide } from "../types"
import type { Executor, FillReport, OrderState, PlaceOrderRequest } from "./executor"

// ------------------------------------------------------------
// PAPER_V1 pipeline: the full V2 stack with the FINAL exchange
// submission intercepted by a simulated exchange.
//
//   • Fill decisions come from the LIVE Polymarket CLOB best-ask
//     for the order's side (injected as priceForSide) — a resting
//     BUY fills when the live ask trades at/below its limit price,
//     exactly the condition a real maker order needs.
//   • Realistic exchange behaviour is injected: network latency,
//     delayed acks, partial fills, rejections, API timeouts, and
//     temporary outages — all tunable via a chaos profile.
//   • A simulated wallet tracks collateral so the whole balance /
//     bankroll / reconciler path exercises real code.
//   • NOTHING here ever talks to the exchange. There is no client,
//     no signer, no credentials — submission is structurally
//     impossible, not just disabled.
// ------------------------------------------------------------

/** Chaos-injection profile. Probabilities are per-call in [0,1]. */
export interface ChaosProfile {
  /** Base one-way network latency range, ms. */
  latencyMinMs: number
  latencyMaxMs: number
  /** Probability a placeOrder is rejected by the "exchange". */
  rejectRate: number
  /** Probability an API call times out (throws after a long delay). */
  timeoutRate: number
  /** Probability a fill is partial (when a fill occurs). */
  partialFillRate: number
  /** Probability the exchange ack is delayed by an extra 1-3s. */
  slowAckRate: number
  /** When > 0, ALL API calls fail for this many ms (temporary outage). */
  outageUntilMs: number
}

// BUG #6 (paper partial-fill unrealism): the previous default of 15% synthetic
// partial fills produced ledger rows where a 7-share FIXED_SHARES order booked
// as 2 or 3 shares (see user report, image-7.png trades #130, #136). At the
// order sizes P4 uses ($0.90-$1.00 · single-digit shares ≈ a few dollars) a
// real Polymarket CLOB order fills fully — book depth dwarfs the request by
// orders of magnitude, and the executor already cancels any true remainder at
// the exchange. Simulating 15% partial fills in paper mode therefore does not
// mirror LIVE_V2 behavior; it invents variance that never appears in
// production, breaks the "FIXED_SHARES buys exactly N shares" contract in the
// ledger, and confounds compounding review because the next PERCENT slot
// compounds off a smaller-than-expected payout. Default the rate to 0; the
// chaos machinery is retained so tests and adversarial simulations can opt in
// via the constructor `chaos` override or a future env knob.
export const DEFAULT_CHAOS: ChaosProfile = {
  latencyMinMs: 40,
  latencyMaxMs: 220,
  rejectRate: 0.05,
  timeoutRate: 0.03,
  partialFillRate: 0,
  slowAckRate: 0.08,
  outageUntilMs: 0,
}


/** Deterministic profile for unit/integration tests: no randomness, no delay. */
export const ZERO_CHAOS: ChaosProfile = {
  latencyMinMs: 0,
  latencyMaxMs: 0,
  rejectRate: 0,
  timeoutRate: 0,
  partialFillRate: 0,
  slowAckRate: 0,
  outageUntilMs: 0,
}

/** A resting order on the simulated book. */
interface RestingOrder {
  order: OpenOrder
  /** Shares matched so far (partial-fill accounting). */
  matched: number
  status: "LIVE" | "MATCHED" | "CANCELED" | "EXPIRED"
  /** Epoch ms the order expires (engine TIF), or null for GTC. */
  expireAtMs: number | null
  createdAtMs: number
  /** checkFill must report a given fill exactly once — a second call
   *  re-reporting the same shares would double-book the trade upstream. */
  fillReported: boolean
  /** Share-weighted average fill price across partial matches (Bug #013). */
  filledNotional: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class PaperExecutor implements Executor {
  readonly label = "PAPER_V1"

  /** Simulated exchange book: exchangeOrderId → resting order. */
  private book = new Map<string, RestingOrder>()
  /** Simulated USDC wallet, dollars. Seeded from persisted value or default. */
  private walletUsd: number
  /** Simulated fills ledger for the account mirror. */
  private trades: LiveAccountTrade[] = []
  chaos: ChaosProfile

  constructor(
    /** LIVE CLOB best-ask for a side — the real fill-decision input. */
    private readonly priceForSide: (side: TradeSide) => number | null,
    opts?: { startingWalletUsd?: number; chaos?: Partial<ChaosProfile> },
  ) {
    // Seed from the SAME source as the paper bankroll (PAPER_STARTING_BALANCE)
    // so syncLiveBalance's wallet read agrees with the ledger baseline —
    // otherwise the dashboard shows a phantom PnL equal to the seed mismatch.
    this.walletUsd = opts?.startingWalletUsd ?? env.PAPER_STARTING_BALANCE
    // Under vitest, default to the deterministic profile so simulation tests
    // are never flaky; explicit chaos overrides still apply on top.
    const base = process.env.VITEST ? ZERO_CHAOS : DEFAULT_CHAOS
    this.chaos = { ...base, ...opts?.chaos }
    logEvent(
      "info",
      `[SIM] Simulated exchange armed — wallet $${this.walletUsd.toFixed(2)}, chaos: reject ${(this.chaos.rejectRate * 100).toFixed(0)}%, timeout ${(this.chaos.timeoutRate * 100).toFixed(0)}%, partial ${(this.chaos.partialFillRate * 100).toFixed(0)}%. NO real orders possible.`,
    )
  }

  // ---------- chaos plumbing ----------

  private latency(): number {
    const { latencyMinMs, latencyMaxMs } = this.chaos
    return latencyMinMs + Math.random() * (latencyMaxMs - latencyMinMs)
  }

  /** Simulate the network + exchange-gateway leg of an API call. */
  private async networkLeg(op: string): Promise<void> {
    if (this.chaos.outageUntilMs > Date.now()) {
      await sleep(this.latency())
      throw new Error(`[SIM] simulated network outage (${op})`)
    }
    if (Math.random() < this.chaos.timeoutRate) {
      await sleep(2_000 + Math.random() * 3_000)
      throw new Error(`[SIM] simulated API timeout (${op})`)
    }
    let ms = this.latency()
    if (Math.random() < this.chaos.slowAckRate) ms += 1_000 + Math.random() * 2_000
    await sleep(ms)
  }

  /** Trigger a temporary full-API outage (for chaos scenarios). */
  simulateOutage(durationMs: number): void {
    this.chaos.outageUntilMs = Date.now() + durationMs
    logEvent("warn", `[SIM] simulated exchange outage for ${Math.round(durationMs / 1000)}s`)
  }

  // ---------- fill engine (driven by LIVE market data) ----------

  /**
   * Evaluate a resting order against the LIVE CLOB. A maker BUY at limit P
   * fills when the live best ask ≤ P (someone crossed into our bid). Uses
   * ONLY live data: when the feed is stale, nothing fills (exactly like a
   * real exchange in a data blackout — the book is still there, but we
   * cannot observe it).
   */
  private evaluate(resting: RestingOrder): void {
    if (resting.status !== "LIVE") return
    if (resting.expireAtMs !== null && Date.now() > resting.expireAtMs) {
      resting.status = "EXPIRED"
      return
    }
    const liveAsk = this.priceForSide(resting.order.side)
    if (liveAsk === null) return // no live data — cannot fill
    if (liveAsk > resting.order.price) return // book hasn't reached our limit

    // Live price crossed our limit — the order fills.
    const remaining = resting.order.shares - resting.matched
    const isPartial = Math.random() < this.chaos.partialFillRate && remaining > 1
    const fillShares = isPartial ? Math.max(1, Math.floor(remaining * (0.3 + Math.random() * 0.5))) : remaining
    resting.matched += fillShares
    if (resting.matched >= resting.order.shares) resting.status = "MATCHED"

    // BUG #013 — Taker realism: when a marketable LIMIT BUY (limit > best
    // ask) crosses into resting sell offers, the CLOB fills at the RESTING
    // ASK, not the taker's limit. Paying `resting.order.price` on every
    // fill made paper systematically over-pay vs. live by (limit - ask) —
    // e.g. a $0.99 limit against a $0.85 ask booked cost $4.95 instead of
    // $4.25 (+16% cost, worse WIN payout math). Fill price is now the
    // better of {limit, live ask} — matches maker-fills-at-limit for
    // non-marketable orders and taker-fills-at-ask for marketable ones.
    const fillPrice = Math.min(resting.order.price, liveAsk)
    const cost = fillShares * fillPrice
    this.walletUsd -= cost
    this.trades.push({
      id: randomUUID(),
      market: resting.order.marketId,
      assetId: resting.order.tokenId,
      outcome: resting.order.side,
      side: "BUY",
      price: fillPrice,
      size: fillShares,
      status: "CONFIRMED",
      traderSide: "MAKER",
      matchTimeMs: Date.now(),
      txHash: null,
      // BUG #012 — attribute the simulated fill to its resting exchange
      // order id so the fill-reconciler can join against the local ledger.
      orderIds: resting.order.exchangeOrderId ? [resting.order.exchangeOrderId] : [],
    })

    // LONG-RUN SAFETY: only the last 25 are ever read (getTradesLive). Cap
    // the buffer so weeks of continuous paper trading can't grow the heap —
    // one fill per 5-min market is ~8,600 entries/month if unbounded.
    if (this.trades.length > 200) this.trades.splice(0, this.trades.length - 200)
    logEvent(
      "trade",
      `[SIM] fill: ${fillShares}/${resting.order.shares} ${resting.order.side} @ $${fillPrice.toFixed(4)} (limit $${resting.order.price.toFixed(2)}, live ask $${liveAsk.toFixed(2)})${isPartial ? " — PARTIAL" : ""}`,
    )
  }

  /** Settlement credit — the engine books WIN payouts through the bankroll;
   *  mirror it in the simulated wallet so reconciler drift stays near zero. */
  creditSettlement(usd: number): void {
    this.walletUsd += usd
  }

  /**
   * AUTHORITY SEAM (Phase 5): the simulated wallet is a MIRROR of the
   * ledger-driven bankroll, never an authority. The engine re-seeds the
   * mirror FROM the persisted bankroll at boot — the in-memory wallet resets
   * to the default on every process restart, and before this seam existed
   * syncLiveBalance copied that stale wallet number OVER the true bankroll
   * (the root cause of balances jumping by the payout instead of the PnL).
   */
  setWalletUsd(usd: number): void {
    const old = this.walletUsd
    this.walletUsd = Math.round(usd * 10000) / 10000
    if (Math.abs(old - this.walletUsd) > 0.005) {
      logEvent("info", `[SIM] wallet mirror re-seeded from ledger bankroll: $${old.toFixed(2)} → $${this.walletUsd.toFixed(2)}`)
    }
  }

  // ---------- Executor contract (same behaviour as LiveExecutor) ----------

  async placeOrder(req: PlaceOrderRequest): Promise<OpenOrder> {
    await this.networkLeg("placeOrder")

    // Same numeric sanitation as live.
    const price = Number(req.price.toFixed(2))
    const size = Math.floor(req.shares)

    // Exchange-style validations (mirrors real CLOB rejections).
    if (size < 1) throw new Error("CLOB rejected order: size below minimum")
    if (price <= 0 || price >= 1) throw new Error("CLOB rejected order: price out of (0,1)")
    if (size * price > this.walletUsd) throw new Error("CLOB rejected order: not enough balance / allowance")
    if (Math.random() < this.chaos.rejectRate) {
      throw new Error("CLOB rejected order: simulated exchange rejection (post-only would cross)")
    }

    const exchangeOrderId = `sim-${randomUUID()}`
    const order: OpenOrder = {
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
    this.book.set(exchangeOrderId, {
      order,
      matched: 0,
      status: "LIVE",
      expireAtMs: req.expireAtMs,
      createdAtMs: Date.now(),
      fillReported: false,
      filledNotional: 0,
    })
    logEvent("info", `[SIM] Maker order live: ${req.side} ${size} @ $${price.toFixed(2)} (id ${exchangeOrderId.slice(0, 12)}...)`)
    return order
  }

  async cancelOrder(order: OpenOrder): Promise<void> {
    await this.networkLeg("cancelOrder")
    const resting = order.exchangeOrderId ? this.book.get(order.exchangeOrderId) : undefined
    if (resting && resting.status === "LIVE") resting.status = "CANCELED"
  }

  async cancelReplace(order: OpenOrder, req: PlaceOrderRequest): Promise<{ order: OpenOrder; latencyMs: number }> {
    const t0 = performance.now()
    // Same duplicate-order safety flow as LiveExecutor.
    try {
      await this.cancelOrder(order)
    } catch (e) {
      const state = await this.getOrderState(order)
      if (state === "LIVE" || state === "UNKNOWN") {
        throw new Error(
          `cancel-replace aborted: cancel failed (${(e as Error).message}) and old order state=${state} — refusing to post a duplicate`,
        )
      }
      logEvent("warn", `[SIM] cancel-replace: cancel call failed but order verified ${state} — proceeding`)
    }
    const next = await this.placeOrder(req)
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10
    return { order: next, latencyMs }
  }

  async checkFill(order: OpenOrder): Promise<FillReport | null> {
    await this.networkLeg("checkFill")
    const resting = order.exchangeOrderId ? this.book.get(order.exchangeOrderId) : undefined
    if (!resting) return null
    this.evaluate(resting)

    const matched = resting.matched
    if (matched <= 0 || resting.fillReported) return null
    resting.fillReported = true
    const isFullyFilled = resting.status === "MATCHED"
    // Same partial-fill semantics as live: report the partial, cancel remainder.
    if (!isFullyFilled) {
      resting.status = "CANCELED"
      logEvent(
        "warn",
        `[SIM] Partial fill ${matched}/${order.shares} — remainder cancelled to prevent an orphaned resting order`,
      )
    }
    const filledShares = matched
    const filledOrder = filledShares !== order.shares ? { ...order, shares: filledShares } : order
    return { order: filledOrder, filledPrice: order.price }
  }

  async getOrderState(order: OpenOrder): Promise<OrderState> {
    await this.networkLeg("getOrderState")
    const resting = order.exchangeOrderId ? this.book.get(order.exchangeOrderId) : undefined
    if (!resting) return "DEAD"
    this.evaluate(resting)
    if (resting.status === "MATCHED") return "MATCHED"
    if (resting.status === "LIVE") return "LIVE"
    return "DEAD"
  }

  // ---------- account-mirror extensions (simulated equivalents) ----------

  async cancelAllOrders(): Promise<void> {
    await this.networkLeg("cancelAllOrders")
    let n = 0
    for (const resting of this.book.values()) {
      if (resting.status === "LIVE") {
        resting.status = "CANCELED"
        n++
      }
    }
    logEvent("info", `[SIM] cancelAll issued — purged ${n} resting order(s)`)
  }

  async getAvailableBalanceUsd(): Promise<number | null> {
    try {
      await this.networkLeg("getBalance")
    } catch {
      return null // same soft-fail as live
    }
    return Math.round(this.walletUsd * 100) / 100
  }

  async getOpenOrdersLive(): Promise<LiveAccountOrder[]> {
    await this.networkLeg("getOpenOrders")
    const out: LiveAccountOrder[] = []
    for (const r of this.book.values()) {
      this.evaluate(r)
      if (r.status !== "LIVE") continue
      out.push({
        id: r.order.exchangeOrderId ?? r.order.clientOrderId,
        market: r.order.marketId,
        assetId: r.order.tokenId,
        outcome: r.order.side,
        side: "BUY",
        price: r.order.price,
        originalSize: r.order.shares,
        sizeMatched: r.matched,
        orderType: r.expireAtMs === null ? "GTC" : "GTD",
        createdAtMs: r.createdAtMs,
      })
    }
    return out
  }

  async getRecentTradesLive(): Promise<LiveAccountTrade[]> {
    await this.networkLeg("getTrades")
    return this.trades.slice(-25).reverse()
  }

  getFunderAddress(): string | null {
    return "0xSIM0000000000000000000000000000000000000"
  }
}
