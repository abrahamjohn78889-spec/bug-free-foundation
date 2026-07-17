// ============================================================
// Core shared types for the Polymarket 5-minute BTC maker bot
// ============================================================

/**
 * Exactly two pipelines share ONE engine — live market discovery, live CLOB
 * data, reconciler, watchdog, risk, standing orders are identical in both.
 * The ONLY difference is the execution backend:
 *   • PAPER_V1 — the final exchange submission is intercepted by a simulated
 *     exchange (PaperExecutor). No client, no signer, no credentials.
 *   • LIVE_V2  — real wallet → real SDK → real Polymarket CLOB.
 */
export type PipelineMode = "PAPER_V1" | "LIVE_V2"

export type EnginePhase =
  | "OFFLINE" // engine not running
  | "WAITING" // candle running, outside the final 20s window
  | "PRIORITY_1" // T-20s .. T-11s : hunt $0.90-$0.94 liquidity
  | "PRIORITY_2" // T-10s .. T-3s  : certainty window $0.95-$0.99
  | "STOPPING" // T-2s .. T-0s   : hold state, all payloads forbidden

export type TradeSide = "UP" | "DOWN"

/** The six quant strategy edges in the registry. */
export type StrategyId = "edge1" | "edge2" | "edge3" | "edge4" | "edge5" | "edge6"

/** Per-edge runtime parameters keyed by the edge's param schema. */
export type StrategyParams = Record<string, number | boolean | string>

/**
 * Time-In-Force for each limit order.
 *  "1m"  — order expires in 60 seconds (FOK-style, auto-cancel after 60s)
 *  "2m"  — order expires in 120 seconds
 *  "GTC" — Good 'Til Cancelled (rests until the STOPPING phase clears it)
 */
export type TIF = "1m" | "2m" | "GTC"

export interface PriceBand {
  min: number
  max: number
}

export interface StrategyConfig {
  /** Priority 1 band (default 0.90 - 0.94), slider adjustable at runtime */
  p1Band: PriceBand
  /** Priority 2 band (default 0.95 - 0.99), slider adjustable at runtime */
  p2Band: PriceBand
  /** Oracle sync drift guard: spot must clear strike by this many USD */
  driftPaddingUsd: number
  /** Polymarket minimum share count per order */
  minShares: number
  /** Max ms allowed for a cancel/replace round trip before warning */
  cancelReplaceBudgetMs: number
  /**
   * Time-In-Force: how long each resting limit order lives before being
   * auto-cancelled by the engine if unfilled.
   *  "1m"  — 60 seconds
   *  "2m"  — 120 seconds
   *  "GTC" — rests until STOPPING phase clears it
   */
  tif: TIF
  /**
   * Absolute price floor — an order will never be placed or allowed
   * to fill below this price (cents on the dollar). Default $0.75.
   */
  priceFloor: number
  /**
   * Absolute price ceiling — an order will never be placed or allowed
   * to fill above this price. Default $0.99.
   */
  priceCeil: number
  /** Which registry edge is currently routed into the pipeline. Null means no strategy is active. */
  activeStrategy: StrategyId | null
  /** P1 (Priority 1) window duration in milliseconds. Default 20000ms (T-20s). Set to 0 to disable time windows. */
  p1WindowMs: number
  /** Per-edge tunable parameters, keyed by StrategyId. */
  strategyParams: Record<StrategyId, StrategyParams>
}

/**
 * Lifecycle status of the independent Standing Limit Order.
 * The order NEVER submits immediately. It waits until the live
 * majority-side price reaches the trigger price (target − $0.01),
 * then places a LIMIT BUY at the target price on the majority side.
 * Runs completely independent of the Time Window and strategy engine.
 */
export type StandingOrderStatus =
  | "ARMED" // active, monitoring — waiting for the trigger price to be reached
  | "TRIGGERED" // trigger price reached, submitting the LIMIT BUY now
  | "RESTING" // LIMIT BUY is live on the book, waiting to fill
  | "FILLED" // filled in the current slot, holding until the next slot refresh
  | "WAITING_MARKET" // the 5-minute market for this slot is not listed yet
  | "NO_DATA" // live Polymarket CLOB prices unavailable — holding, never trades on stale/modeled data
  | "OUT_OF_RANGE" // majority price is outside the [min, max] guardrail band
  | "INSUFFICIENT" // capital pool too low to place the order
  | "REFRESHING" // slot rolled over — re-arming for the new market
  | "PAUSED" // user paused; no monitoring or submission until resumed
  | "BLOCKED" // risk gate veto (kill switch / daily caps) — armed, auto-resumes when the gate clears
  | "WINDOW_WAITING" // final entry window has not opened yet — monitoring only, no order until remaining time ≤ window
  | "WINDOW_EXPIRED" // settlement boundary edge case: trigger reached but the market settled before submission
  | "WAITING_SETTLE" // BUG #5: PERCENT compounding is holding until prior lots settle so sizing uses the fresh balance

/**
 * Position sizing model for the Standing Limit Order.
 *
 *  • FIXED_SHARES — legacy behavior: buy exactly `sizeValue` shares every time.
 *  • FIXED_USD    — spend a fixed dollar amount; shares = floor(usd / limitPrice).
 *  • PERCENT      — AUTOMATIC COMPOUNDING: spend `sizeValue`% of the CURRENT
 *    capital pool (balance + dust reserve — the ledger-authoritative bankroll)
 *    computed at FIRE TIME, not arm time. Every settlement immediately updates
 *    the pool, so the next order sizes from the new balance with no manual
 *    intervention, dashboard refresh, or restart. Works identically in
 *    PAPER_V1 and LIVE_V2 (both share the same Bankroll seam).
 */
export type SloSizingMode = "FIXED_SHARES" | "FIXED_USD" | "PERCENT"

/**
 * How the Standing Limit Order decides WHEN the trigger fires relative to the
 * majority-side price. Configurable in the backend; the dashboard may expose it
 * later. The engine is designed so adding modes never requires a rewrite.
 *
 *  • UPWARD_CROSSING (default) — fire only when the majority-side price crosses
 *    from BELOW the trigger to AT/ABOVE it. Requires a fresh crossing before
 *    each entry, which naturally prevents duplicate submissions within a market.
 *  • AT_OR_ABOVE (future) — fire whenever the majority-side price is at or above
 *    the trigger, re-arming immediately after each fill. Subject to safeguards.
 */
export type TriggerMode = "UPWARD_CROSSING" | "AT_OR_ABOVE"

/**
 * An independent standing limit order using a majority-side,
 * trigger-price execution model. Fully decoupled from the Time
 * Window feature and the strategy engine.
 */
export interface StandingLimitOrder {
  /** Target LIMIT BUY price entered by the user (e.g. 0.95). */
  limitPrice: number
  /** User-defined trigger price (at or below the target). Order arms only once the majority price reaches this. */
  triggerPrice: number
  /** How the trigger fires relative to the majority price (default: upward crossing). */
  triggerMode: TriggerMode
  /** Lower guardrail — order will not operate when majority price is below this. */
  minPrice: number
  /** Upper guardrail — order will not operate when majority price is above this. */
  maxPrice: number
  /**
   * Shares for the NEXT order. For FIXED_SHARES this is the configured count;
   * for FIXED_USD / PERCENT it is a live estimate computed from the current
   * bankroll and limit price (the authoritative count is recomputed at fire
   * time). 0 when the pool cannot afford a single share.
   */
  shares: number
  /** Position sizing model (FIXED_SHARES | FIXED_USD | PERCENT). */
  sizingMode: SloSizingMode
  /** Meaning depends on sizingMode: share count, dollar amount, or percent of pool. */
  sizeValue: number
  /**
   * FINAL ENTRY WINDOW in ms measured backwards from SETTLEMENT of the
   * 5-minute market, or null when disabled. The trigger may only fire while
   * the REMAINING market time is ≤ this window (the last N seconds before
   * settlement). Before that the order monitors but never places.
   */
  entryWindowMs: number | null
  /**
   * Milliseconds until the final entry window OPENS for the CURRENT market
   * (>0 = waiting, 0 = window ACTIVE now, null = window disabled).
   * While active, the time remaining in the window is the market's own
   * settlement countdown (tMinusMs). Live countdown for the dashboard.
   */
  entryWindowOpensInMs: number | null
  /** How many times the order has filled since it was armed. */
  executionCount: number
  /** Epoch ms of the last fill (null if never filled). */
  lastExecutedAtMs: number | null
  /** Current lifecycle status. */
  status: StandingOrderStatus
  /** The current majority side (higher-priced contract), or null if unknown. */
  majoritySide: TradeSide | null
  /** Live price of the current majority side. */
  majorityPrice: number
  /**
   * The side locked in by the FIRST fill of the current market. Once set,
   * every subsequent order in this market trades this side until the next
   * 5-minute market resets it. Null before the first fill.
   */
  lockedDirection: TradeSide | null
  /** Number of open (unsettled) lots held for the current market. */
  openPositionCount: number
  /** The side the LIMIT BUY is currently resting on, or null. */
  restingSide: TradeSide | null
  /** Slot end (epoch ms) the current order belongs to. */
  slotEndMs: number
  /** Whether the user has paused the strategy. */
  paused: boolean
  /** True when routed to the live CLOB (LIVE_V2); false = paper simulation. */
  live: boolean
  /**
   * The live filled position for the current slot, surfaced the instant the
   * exchange confirms the fill (before market resolution) so the ledger can
   * show the execution and live unrealized PnL in real time. Null until filled.
   */
  openPosition: StandingOrderOpenPosition | null
  /** True when the current slot's market has already closed/resolved on Polymarket. */
  marketClosed: boolean
  /** True when an active position is being polled for early settlement. */
  awaitingEarlySettlement: boolean
  /** Why the risk gate is blocking orders (status BLOCKED), or null. Surfaced
   *  so a kill-switch/daily-cap halt is never invisible on the dashboard. */
  blockedReason: string | null
  /** Latency breakdown of the most recent order submission (ms), or null if
   *  no order has been submitted this process lifetime. */
  lastExecutionLatency: import("./standing-order").SloExecutionLatency | null
  /** Requested vs effective shares of the most recent sizing computation —
   *  proves whether a risk clamp altered the operator's configured size. */
  lastSizing: { requestedShares: number; effectiveShares: number; sizingMode: string } | null
}

/** A confirmed-but-unresolved standing-order fill, shown live in the ledger. */
export interface StandingOrderOpenPosition {
  marketId: string
  side: TradeSide
  entryPrice: number
  shares: number
  cost: number
  /** Epoch ms the fill was confirmed. */
  filledAtMs: number
  /**
   * Live mark = current best ask of the held side, read from the Polymarket
   * CLOB. Null when live data is unavailable (never a modeled/cached value).
   */
  markPrice: number | null
  /** True when markPrice is a fresh live CLOB value. */
  markFresh: boolean
  /** Live position value = shares × markPrice, or null when mark is unavailable. */
  positionValue: number | null
  /** Live unrealized PnL = positionValue − cost, or null when mark is unavailable. */
  unrealizedPnl: number | null
}

export interface OpenOrder {
  clientOrderId: string
  exchangeOrderId: string | null
  marketId: string
  tokenId: string
  side: TradeSide
  price: number
  shares: number
  placedAtMs: number
  phase: EnginePhase
}

export interface SettledTrade {
  id: number
  marketId: string
  slotEndMs: number
  side: TradeSide
  price: number
  shares: number
  cost: number
  /** "OPEN" while the position is live (pre-resolution); otherwise the settled outcome. */
  result: "OPEN" | "WIN" | "LOSS" | "SCRATCH"
  pnl: number
  balanceAfter: number
  dustSaved: number
  mode: PipelineMode
  createdAt: string
  settledAt: string
  /** Lifecycle status: OPEN (filled, awaiting resolution) or SETTLED. */
  status: "OPEN" | "SETTLED"
  /** Exchange order id (Polymarket CLOB order id, or sim id in paper). */
  orderId: string | null
  /** Unique trade/execution id. */
  tradeUid: string | null
  /** Epoch ms the execution filled. */
  entryAtMs: number | null
  /** Live mark price of the held side (updated while OPEN). */
  markPrice: number | null
  /** Live unrealized PnL while OPEN. */
  unrealizedPnl: number | null
  /**
   * Permanent per-trade audit record (JSON): why the trade opened, trigger
   * condition, side selection, fill reason, settlement result and source,
   * PnL calculation, and any recovery/fallback logic used.
   */
  explanation: string | null
}

export interface SpotTick {
  price: number
  tsMs: number
  source: "binance" | "coinbase" | "chainlink-onchain" | "chainlink-datastreams"
}

export interface EngineEvent {
  tsMs: number
  level: "info" | "warn" | "error" | "trade"
  msg: string
}

/**
 * Aggregate lifecycle metrics shown in the Intelligence Feed summary footer.
 * All values are for the current pipeline mode (paper vs live).
 */
export interface FeedStats {
  /** Total LIMIT BUY orders submitted to the book. */
  ordersSubmitted: number
  /** Total orders that filled (each ledger fill row). */
  ordersFilled: number
  /** Sum of shares across every fill. */
  totalShares: number
  /** Positions currently open (filled, awaiting resolution). */
  openPositions: number
  /** Positions that have resolved/settled. */
  closedPositions: number
  /** Settled winners. */
  wins: number
  /** Settled losers. */
  losses: number
  /** Realized PnL across settled positions. */
  realizedPnl: number
  /** Live unrealized PnL across open positions. */
  unrealizedPnl: number
}

/** A single resting open order on the authenticated Polymarket account. */
export interface LiveAccountOrder {
  id: string
  market: string
  assetId: string
  outcome: string
  side: string
  price: number
  originalSize: number
  sizeMatched: number
  orderType: string
  createdAtMs: number
}

/** A single recent trade/fill on the authenticated Polymarket account. */
export interface LiveAccountTrade {
  id: string
  market: string
  assetId: string
  outcome: string
  side: string
  price: number
  size: number
  status: string
  traderSide: string
  matchTimeMs: number
  txHash: string | null
  /**
   * BUG #012 — exchange order id(s) associated with this fill event.
   *  • LIVE_V2: populated from CLOB `/data/trades`
   *    (`maker_orders[].order_id` for maker fills; `taker_order_id` fallback).
   *  • PAPER_V1: populated from the simulated resting order.
   * Empty array means the executor could not attribute the fill to a known
   * order — the fill-reconciler surfaces these as UNATTRIBUTED.
   */
  orderIds: string[]
}


/** A single active position, from the official Polymarket Data API. */
export interface LiveAccountPosition {
  conditionId: string
  asset: string
  title: string
  outcome: string
  size: number
  avgPrice: number
  curPrice: number
  currentValue: number
  initialValue: number
  cashPnl: number
  percentPnl: number
  realizedPnl: number
  redeemable: boolean
}

/**
 * Live snapshot of the authenticated Polymarket account, assembled from the
 * official CLOB SDK (balance/orders/trades) and the official public Data API
 * (positions/value/PnL). Read-only: this NEVER feeds trading logic — it exists
 * purely to mirror the real account on the dashboard while LIVE_V2 runs.
 *
 * Every numeric field is nullable: a field is null when its source call failed
 * or the datum is genuinely unavailable, so the UI can show the true state
 * instead of a fabricated value. `unavailable` lists fields with NO official
 * source at all (e.g. username), and `errors` records soft per-source failures.
 */
export interface LiveAccountData {
  fetchedAtMs: number
  /** Funder/proxy/deposit address the account trades from (from config). */
  walletAddress: string | null
  /** Not exposed by any official API keyed by address — always null. */
  username: string | null
  /** Available USDC collateral (getBalanceAllowance), in dollars. */
  availableUsd: number | null
  /** Total portfolio value (Data API /value), in dollars. */
  portfolioValueUsd: number | null
  /** Sum of unrealized cash PnL across open positions, in dollars. */
  totalUnrealizedPnl: number | null
  /** Sum of realized PnL across positions, in dollars. */
  totalRealizedPnl: number | null
  openOrders: LiveAccountOrder[]
  positions: LiveAccountPosition[]
  recentTrades: LiveAccountTrade[]
  stats: {
    openOrderCount: number
    positionCount: number
    recentTradeCount: number
  }
  /** Fields with no official retrieval path, surfaced honestly in the UI. */
  unavailable: string[]
  /** Soft errors from partial source failures (never thrown). */
  errors: string[]
}

export interface EngineSnapshot {
  running: boolean
  mode: PipelineMode
  phase: EnginePhase
  slotEndMs: number
  tMinusMs: number
  clockOffsetMs: number
  clockSynced: boolean
  spot: SpotTick | null
  strike: number | null
  direction: TradeSide | null
  driftGuardClear: boolean
  /**
   * Canonical UP/DOWN contract price = live Polymarket best ask (BUY).
   * NULL when the live CLOB feed is not fresh — the UI must show NO DATA
   * rather than any modeled, cached, or estimated value.
   */
  upTokenPrice: number | null
  downTokenPrice: number | null
  /**
   * Full live Polymarket order-book quote for each side (bid/ask/mid/last),
   * read directly from clob.polymarket.com. Null when the feed is not fresh.
   */
  clobQuote: { up: TokenQuote; down: TokenQuote } | null
  /**
   * Aggregate live order-book depth per side (levels + USD notional), from
   * REST /book polls and WS book snapshots. Null per side until first read.
   */
  clobBook: { up: TokenBookDepth | null; down: TokenBookDepth | null }
  /**
   * Realized ask change over the trailing ~60s window, per side. Null until
   * enough live history exists (e.g. right after a market rollover).
   */
  clobPriceChange: { up: number; down: number; windowMs: number } | null
  balance: number
  dustReserve: number
  startingBalance: number
  totalPnl: number
  wins: number
  losses: number
  openOrder: OpenOrder | null
  lastCancelReplaceMs: number | null
  /** The registry edge currently routed into the pipeline. Null means no strategy is active (only SLO runs). */
  activeStrategy: StrategyId | null
  config: StrategyConfig
  events: EngineEvent[]
  telegramConnected: boolean
  liveKeysLoaded: boolean
  /** Gamma-resolved market for the current slot (null until discovered) */
  liveMarket: {
    slug: string
    question: string
    conditionId: string
    active: boolean
    closed: boolean
    upTokenId: string
    downTokenId: string
    volumeUsd: number | null
    liquidityUsd: number | null
    endDateIso: string | null
  } | null
  /** LIVE_V2 market discovery status: null in PAPER_V1, "ready" when market is loaded, "waiting" when searching for it */
  marketDiscovery: "ready" | "waiting" | null
  /** True while a LIVE_V2 settlement is polling for the official resolution */
  awaitingResolution: boolean
  /** The currently active standing limit order, or null if none is set. */
  standingLimitOrder: StandingLimitOrder | null
  /** Latest exchange-truth reconciliation report (LIVE_V2, null until first run). */
  reconcile: {
    atMs: number
    ok: boolean
    exchangeOpenOrders: number
    trackedOrders: number
    untrackedOrderIds: string[]
    missingOrderIds: string[]
    walletUsd: number | null
    localBalanceUsd: number
    walletDriftUsd: number | null
    error: string | null
  } | null
  /** Self-healing watchdog state: repairs performed + process resource use. */
  watchdog: {
    lastCheckAtMs: number
    checksRun: number
    marketWsReconnects: number
    userWsReconnects: number
    staleQuoteRecoveries: number
    sloLoopRestarts: number
    rssMb: number
    heapUsedMb: number
    uptimeSec: number
  }
  /** Risk manager state: kill switch, limits, daily counters. Always present. */
  risk: {
    killSwitch: { engaged: boolean; reason: string; atMs: number; source: "OPERATOR" | "BREAKER" | "" }
    limits: { maxDailyLossUsd: number; maxOrderNotionalUsd: number; maxDailyOrders: number; maxSharesPerOrder: number }
    dailyRealizedPnl: number
    dailySettledTrades: number
    dailyOrdersSubmitted: number
  }
  /** Aggregate lifecycle metrics for the Intelligence Feed summary footer. */
  feedStats: FeedStats
  /** Most recent continuous accounting audit (identities A–D), or null. */
  lastAccountingAudit: import("./accounting-verifier").AccountingAuditSummary | null
  /**
   * True when live CLOB prices (from clob.polymarket.com) are fresh and
   * driving the upTokenPrice / downTokenPrice fields. False means there is
   * NO live data — consumers show NO DATA and the engine holds (there is no
   * model, cache, or estimate fallback).
   */
  clobPricesFresh: boolean
  /**
   * Diagnostic state from the CLOB price feed. Always present so the Signal
   * Tank and Intel Feed can surface the exact failure reason instead of just
   * showing "prices unavailable". Zero overhead when the feed is healthy.
   */
  clobDiagnostics: {
    upTokenId: string | null
    downTokenId: string | null
    upQuoteAgeMs: number | null
    downQuoteAgeMs: number | null
    consecutiveFailures: number
    lastSuccessMs: number
    /** Epoch ms of the most recent successful REST update (0 = never). */
    lastRestUpdateMs: number
    /** Epoch ms of the most recent failed poll (0 = never failed). */
    lastFailMs: number
    lastFailReason: string
    totalPolls: number
    totalFailedPolls: number
    /** Round-trip duration of the most recent successful REST poll (ms). */
    apiLatencyMs: number | null
    /** REST poll cadence in ms (heartbeat behind the WS stream). */
    pollIntervalMs: number
    /** Feed generation — bumps on every market/token change; quotes from a
     *  previous generation can never be consumed. */
    generation: number
    /** Monotonic quote-write sequence within the feed. */
    sequence: number
    /** Epoch ms of the last generation bump (market change), 0 = never. */
    lastGenerationChangeMs: number
    /** Why validatedQuotes() last returned null ("" = last validation passed). */
    validationFailReason: string
    /** True when the last poll saw an EMPTY ask book (fresh market, no liquidity)
     *  — a distinct state from a fetch failure. */
    emptyBook: boolean
    /** Adaptive REST cadence: SLOW when WS is healthy, FAST when WS is degraded. */
    restCadence: "FAST" | "SLOW"
    /** WebSocket stream health (connection + latency). Null-safe for consumers. */
    ws: {
      connected: boolean
      assetIds: string[]
      connectedAtMs: number
      lastMessageAtMs: number
      reconnectAttempts: number
      /** Last measured ping/pong round-trip in ms (null before first pong). */
      pingRttMs: number | null
      totalDisconnects: number
      /** Epoch ms of the last pong received on the CURRENT socket (0 = none). */
      lastPongAtMs: number
      /** Epoch ms the subscribe was last sent on the CURRENT socket (0 = none). */
      subscribeSentAtMs: number
    }
  }
  /**
   * Engine market-transition state. ROLLING_OVER = the rollover barrier is
   * holding (no trigger evaluation runs) until the new market's pipeline is
   * verified end-to-end; LIVE = decisions running normally.
   */
  rolloverState: "LIVE" | "ROLLING_OVER"
  /**
   * Atomic validated snapshot state for the Feed Diagnostics panel. Null when
   * validatedQuotes() currently returns null (see clobDiagnostics.validationFailReason).
   */
  feedSnapshotInfo: {
    generation: number
    sequence: number
    timestampMs: number
    upAgeMs: number
    downAgeMs: number
    wsFreshMs: number | null
    restFreshMs: number | null
    confidence: "HIGH" | "MEDIUM" | "LOW"
    upSource: "WS" | "REST"
    downSource: "WS" | "REST"
  } | null
  /**
   * Live authenticated Polymarket account mirror. Null in PAPER_V1 and until
   * the first LIVE_V2 sync completes. Read-only display data only.
   */
  liveAccount: LiveAccountData | null
}

/** A live Polymarket order-book quote for a single outcome token. */
export interface TokenQuote {
  /** Best ask (price to BUY) — the canonical outcome price. */
  ask: number
  /** Best bid (price to SELL), or null if unavailable. */
  bid: number | null
  /** Book midpoint, or null if unavailable. */
  mid: number | null
  /** Last traded price, or null if unavailable. */
  last: number | null
  /** Side of the last trade ("BUY" | "SELL"), or null if unavailable. */
  lastSide: "BUY" | "SELL" | null
}

/** Aggregate live order-book depth for a single outcome token. */
export interface TokenBookDepth {
  bidLevels: number
  askLevels: number
  /** Sum of price x size across all bid levels (USD notional). */
  bidNotionalUsd: number
  /** Sum of price x size across all ask levels (USD notional). */
  askNotionalUsd: number
  fetchedAtMs: number
}
