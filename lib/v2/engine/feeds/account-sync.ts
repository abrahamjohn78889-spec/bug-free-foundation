import { env } from "../config"
import { logEvent } from "../events"
import type { Executor } from "../execution/executor"
import type { LiveAccountData, LiveAccountPosition } from "../types"

// ------------------------------------------------------------
// LIVE_V2 account mirror.
//
// Assembles a read-only snapshot of the authenticated Polymarket account from
// two OFFICIAL sources and hands it to the engine for the dashboard:
//   • CLOB SDK (via the executor): available USDC, open orders, recent trades.
//   • Public Data API (keyed by wallet address): positions, portfolio value,
//     and PnL — none of which the CLOB SDK exposes.
//
// This NEVER feeds trading logic. It is display-only, fully null-safe, and
// never throws into the caller: any source failure degrades that one field to
// null and is recorded in `errors[]`. Refreshes are always fire-and-forget so
// the 50ms trading loop is never blocked.
//
// Efficiency guarantees (per the spec — "do not poll unnecessarily"):
//   • A hard MIN_REST_INTERVAL floor coalesces bursts into one REST pass.
//   • WS account events call requestRefresh() → a short debounce window batches
//     rapid order/trade/cancel events into a single refresh.
//   • A slow FALLBACK_POLL only fires as a safety net if nothing else refreshed
//     recently (e.g. the User WebSocket is down).
// ------------------------------------------------------------

/** Never issue REST syncs more often than this (except the very first). */
const MIN_REST_INTERVAL_MS = 4_000
/** Coalesce window for WS-triggered refreshes. */
const WS_DEBOUNCE_MS = 1_500
/** Safety poll — only refreshes if the cache is older than this. */
const FALLBACK_POLL_MS = 30_000
/** Per-request timeout for the public Data API. */
const DATA_API_TIMEOUT_MS = 8_000
/** Fields with no official retrieval path keyed by wallet address. */
const UNAVAILABLE_FIELDS = ["username"] as const

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

type RawPosition = {
  conditionId?: string
  asset?: string
  title?: string
  outcome?: string
  size?: number
  avgPrice?: number
  curPrice?: number
  currentValue?: number
  initialValue?: number
  cashPnl?: number
  percentPnl?: number
  realizedPnl?: number
  redeemable?: boolean
}

export class AccountSync {
  private cache: LiveAccountData | null = null
  private lastSyncMs = 0
  private syncing = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private fallbackTimer: ReturnType<typeof setInterval> | null = null
  private stopped = true

  constructor(
    private readonly executor: Executor,
    private readonly dataApiHost: string = env.DATA_API_HOST,
  ) {}

  /** Latest cached account snapshot (null until the first sync completes). */
  get(): LiveAccountData | null {
    return this.cache
  }

  /** Begin the safety-net poll and kick off an immediate first sync. */
  start(): void {
    this.stopped = false
    void this.refresh("start", true)
    if (!this.fallbackTimer) {
      this.fallbackTimer = setInterval(() => {
        // Only poll if nothing refreshed us recently (WS covers the hot path).
        if (Date.now() - this.lastSyncMs >= FALLBACK_POLL_MS) void this.refresh("fallback")
      }, FALLBACK_POLL_MS)
    }
  }

  /** Stop timers and clear transient state. Cache is retained for display. */
  stop(): void {
    this.stopped = true
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }

  /**
   * Ask for a refresh in response to an event (WS order/trade/cancel, a new
   * slot, etc.). Debounced so a burst of events triggers a single REST pass.
   */
  requestRefresh(reason: string): void {
    if (this.stopped) return
    if (this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.refresh(reason)
    }, WS_DEBOUNCE_MS)
  }

  /**
   * Pull every source in parallel and rebuild the cache. Guarded against
   * overlap and throttled to MIN_REST_INTERVAL_MS unless `force` is set.
   * Never throws.
   */
  async refresh(reason: string, force = false): Promise<void> {
    if (this.stopped && !force) return
    if (this.syncing) return
    if (!force && Date.now() - this.lastSyncMs < MIN_REST_INTERVAL_MS) return
    this.syncing = true

    const errors: string[] = []
    const address = this.executor.getFunderAddress?.() ?? null

    const [balanceR, ordersR, tradesR, positionsR, valueR] = await Promise.allSettled([
      this.executor.getAvailableBalanceUsd?.() ?? Promise.resolve(null),
      this.executor.getOpenOrdersLive?.() ?? Promise.resolve([]),
      this.executor.getRecentTradesLive?.() ?? Promise.resolve([]),
      address
        ? fetchJson<RawPosition[]>(
            `${this.dataApiHost}/positions?user=${address}&sizeThreshold=0.1&limit=100&sortBy=CURRENT&sortDirection=DESC`,
            DATA_API_TIMEOUT_MS,
          )
        : Promise.resolve([]),
      address
        ? fetchJson<Array<{ value?: number }>>(`${this.dataApiHost}/value?user=${address}`, DATA_API_TIMEOUT_MS)
        : Promise.resolve([]),
    ])

    const availableUsd = balanceR.status === "fulfilled" ? balanceR.value : null
    if (balanceR.status === "rejected") errors.push(`balance: ${String(balanceR.reason)}`)

    const openOrders = ordersR.status === "fulfilled" ? ordersR.value : []
    if (ordersR.status === "rejected") errors.push(`openOrders: ${String(ordersR.reason)}`)

    const recentTrades = tradesR.status === "fulfilled" ? tradesR.value : []
    if (tradesR.status === "rejected") errors.push(`trades: ${String(tradesR.reason)}`)

    let positions: LiveAccountPosition[] = []
    let totalUnrealizedPnl: number | null = null
    let totalRealizedPnl: number | null = null
    if (positionsR.status === "fulfilled" && Array.isArray(positionsR.value)) {
      positions = positionsR.value.map((p) => ({
        conditionId: String(p.conditionId ?? ""),
        asset: String(p.asset ?? ""),
        title: String(p.title ?? ""),
        outcome: String(p.outcome ?? ""),
        size: Number(p.size ?? 0),
        avgPrice: Number(p.avgPrice ?? 0),
        curPrice: Number(p.curPrice ?? 0),
        currentValue: Number(p.currentValue ?? 0),
        initialValue: Number(p.initialValue ?? 0),
        cashPnl: Number(p.cashPnl ?? 0),
        percentPnl: Number(p.percentPnl ?? 0),
        realizedPnl: Number(p.realizedPnl ?? 0),
        redeemable: Boolean(p.redeemable),
      }))
      totalUnrealizedPnl = positions.reduce((s, p) => s + (Number.isFinite(p.cashPnl) ? p.cashPnl : 0), 0)
      totalRealizedPnl = positions.reduce((s, p) => s + (Number.isFinite(p.realizedPnl) ? p.realizedPnl : 0), 0)
    } else if (positionsR.status === "rejected") {
      errors.push(`positions: ${String(positionsR.reason)}`)
    }

    let portfolioValueUsd: number | null = null
    if (valueR.status === "fulfilled" && Array.isArray(valueR.value) && valueR.value[0]?.value !== undefined) {
      const v = Number(valueR.value[0].value)
      portfolioValueUsd = Number.isFinite(v) ? v : null
    } else if (valueR.status === "rejected") {
      errors.push(`value: ${String(valueR.reason)}`)
    }

    this.cache = {
      fetchedAtMs: Date.now(),
      walletAddress: address,
      username: null, // no official API resolves a username by address
      availableUsd,
      portfolioValueUsd,
      totalUnrealizedPnl,
      totalRealizedPnl,
      openOrders,
      positions,
      recentTrades,
      stats: {
        openOrderCount: openOrders.length,
        positionCount: positions.length,
        recentTradeCount: recentTrades.length,
      },
      unavailable: [...UNAVAILABLE_FIELDS],
      errors,
    }
    this.lastSyncMs = Date.now()
    this.syncing = false

    if (errors.length) {
      const errorDetail = errors.map((e) => `  • ${e}`).join("\n")
      const tradingImpact = balanceR.status === "fulfilled" && ordersR.status === "fulfilled" ? "NONE" : "POSSIBLE"
      logEvent(
        "warn",
        `[LIVE_V2] account sync (${reason}) recovered with ${errors.length} source error(s):\n${errorDetail}\nTrading impact: ${tradingImpact}`,
      )
    } else {
      logEvent("info", `[LIVE_V2] account synced (${reason}): $${(availableUsd ?? 0).toFixed(2)} avail, ${positions.length} pos, ${openOrders.length} open`)
    }
  }
}
