import WebSocket from "ws"
import { env } from "../config"
import { logEvent } from "../events"
import { createProxiedWebSocket } from "../proxy"

// ------------------------------------------------------------
// ClobWsClient — low-latency market-data stream for the Polymarket
// CLOB "market" channel. It maintains the live best ASK (price to BUY)
// for a set of token IDs and pushes every change to a callback so the
// trigger can be evaluated event-driven instead of on a timer.
//
// Protocol (docs.polymarket.com CLOB websocket market-channel):
//   • endpoint:  wss://ws-subscriptions-clob.polymarket.com/ws/market
//   • subscribe: { assets_ids, type: "market", custom_feature_enabled: true }
//   • events consumed:
//       - "book"          full snapshot (bids/asks) on subscribe + on trades
//       - "price_change"  incremental level updates (carries best_ask)
//       - "best_bid_ask"  explicit best bid/ask change (custom feature)
//
// This is an OPTIMIZATION layer. The owning ClobPriceFeed keeps polling
// as a fallback, so if the socket is unavailable the system degrades to
// the previous behavior with zero change in correctness.
// ------------------------------------------------------------

const WS_MARKET_URL = `${env.CLOB_WS_HOST}/market`
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000
const PING_INTERVAL_MS = 10_000
/** OPEN socket with no message/pong for this long → internal zombie self-heal
 *  (the external watchdog's 90s threshold remains the outer backstop). */
const ZOMBIE_SILENCE_MS = 30_000
/** After subscribing, expect first traffic within this window; then re-send
 *  the subscribe once, and force a reconnect if still silent. */
const SUBSCRIBE_VERIFY_MS = 10_000

export interface WsBestAsk {
  tokenId: string
  ask: number
  bid: number | null
  atMs: number
}

/** Aggregate order-book depth computed from a full WS "book" snapshot. */
export interface WsBookDepth {
  tokenId: string
  bidLevels: number
  askLevels: number
  /** Sum of price x size across all bid levels (USD notional). */
  bidNotionalUsd: number
  /** Sum of price x size across all ask levels (USD notional). */
  askNotionalUsd: number
  atMs: number
}

type UpdateHandler = (u: WsBestAsk) => void
type BookHandler = (b: WsBookDepth) => void

export class ClobWsClient {
  private ws: WebSocket | null = null
  private assetIds: string[] = []
  private stopped = true
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private onUpdate: UpdateHandler
  private onBook: BookHandler | null = null
  private connectedAtMs = 0
  private lastMessageAtMs = 0
  // Ping/pong round-trip latency: measured on every keepalive ping so the
  // Signal Tank can display live WS latency instead of guessing from msg age.
  private lastPingSentMs = 0
  private lastPingRttMs: number | null = null
  private lastPongAtMs = 0
  private totalDisconnects = 0
  // Subscription verification: when the subscribe was last sent and whether
  // the one allowed re-send has been used for the current subscription.
  private subscribeSentAtMs = 0
  private resubscribeAttempted = false

  constructor(onUpdate: UpdateHandler, onBook?: BookHandler) {
    this.onUpdate = onUpdate
    this.onBook = onBook ?? null
  }

  /** True when the socket is open and has received a message recently. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.lastMessageAtMs > 0
  }

  diagnostics() {
    return {
      connected: this.connected,
      assetIds: this.assetIds,
      connectedAtMs: this.connectedAtMs,
      lastMessageAtMs: this.lastMessageAtMs,
      reconnectAttempts: this.reconnectAttempts,
      /** Last measured ping/pong round-trip in ms (null before first pong). */
      pingRttMs: this.lastPingRttMs,
      totalDisconnects: this.totalDisconnects,
      lastPongAtMs: this.lastPongAtMs,
      subscribeSentAtMs: this.subscribeSentAtMs,
    }
  }

  /** Set the token IDs to stream and (re)subscribe. Cheap no-op if unchanged. */
  setAssets(tokenIds: string[]) {
    const next = [...tokenIds].filter(Boolean).sort()
    if (next.length === this.assetIds.length && next.every((id, i) => id === this.assetIds[i])) {
      return
    }
    this.assetIds = next
    if (!this.stopped) this.subscribe()
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    this.clearTimers()
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  /**
   * ZOMBIE-SOCKET RECOVERY: tear down the current socket and reconnect
   * immediately. Used by the watchdog when the socket reports OPEN but has
   * not delivered a message in a long time (half-open TCP after an internet
   * blip, NAT timeout, or a silent server-side drop — "close" never fires).
   */
  forceReconnect(reason: string) {
    logEvent("warn", `[CLOB ws] force reconnect: ${reason}`)
    this.totalDisconnects++
    this.lastPingRttMs = null
    this.clearTimers()
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.terminate() // hard-kill; close() can hang on a dead TCP path
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    if (!this.stopped) this.connect()
  }

  // ---------- internals ----------

  private clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private connect() {
    if (this.stopped) return
    // DUPLICATE-SOCKET GUARD: never open a second socket while one exists.
    // Tear down any previous socket (and its timers) first, so exactly one
    // connection can exist at any moment.
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.terminate()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.clearTimers()
    // PER-CONNECTION STATE RESET: `connected` and zombie checks must reflect
    // ONLY the current socket — never traffic from a previous connection.
    this.lastMessageAtMs = 0
    this.lastPongAtMs = 0
    this.lastPingSentMs = 0
    this.subscribeSentAtMs = 0
    this.resubscribeAttempted = false
    try {
      const ws = createProxiedWebSocket(WS_MARKET_URL)
      this.ws = ws

      ws.on("open", () => {
        this.connectedAtMs = Date.now()
        this.reconnectAttempts = 0
        this.subscribe()
        // Application-level keepalive + supervision: the server drops idle
        // sockets, and a half-open TCP path never fires "close" on its own.
        this.pingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return
          try {
            this.lastPingSentMs = Date.now()
            ws.ping()
          } catch {
            /* ignore */
          }
          this.superviseCurrentSocket()
        }, PING_INTERVAL_MS)
        logEvent("info", "[CLOB ws] connected to market channel")
      })

      // Pong closes the ping round-trip: live WS latency for the Signal Tank.
      ws.on("pong", () => {
        this.lastPongAtMs = Date.now()
        if (this.lastPingSentMs > 0) {
          this.lastPingRttMs = Date.now() - this.lastPingSentMs
        }
      })

      ws.on("message", (raw: WebSocket.RawData) => {
        this.lastMessageAtMs = Date.now()
        this.resubscribeAttempted = false // traffic → subscription verified
        this.handleMessage(raw.toString())
      })

      ws.on("close", (code: number, reason: Buffer) => {
        logEvent("warn", `[CLOB ws] closed (code=${code}${reason.length ? `, ${reason.toString().slice(0, 80)}` : ""}) — reconnecting`)
        this.totalDisconnects++
        this.lastPingRttMs = null
        this.scheduleReconnect()
      })
      ws.on("error", (err: Error) => {
        // Errors are followed by a close; log the reason once and let reconnect handle it.
        logEvent("warn", `[CLOB ws] socket error: ${err.message}`)
      })
    } catch (e) {
      logEvent("warn", `[CLOB ws] connect failed: ${e instanceof Error ? e.message : String(e)}`)
      this.scheduleReconnect()
    }
  }

  private subscribe() {
    if (this.ws?.readyState !== WebSocket.OPEN || this.assetIds.length === 0) return
    const msg = { assets_ids: this.assetIds, type: "market", custom_feature_enabled: true }
    try {
      this.ws.send(JSON.stringify(msg))
      // Start subscription verification: traffic is expected within
      // SUBSCRIBE_VERIFY_MS, checked by superviseCurrentSocket().
      this.subscribeSentAtMs = Date.now()
    } catch (e) {
      logEvent("warn", `[CLOB ws] subscribe failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Supervision of the CURRENT socket, run on the ping cadence:
   *
   * 1. SUBSCRIPTION VERIFICATION — an OPEN socket that never delivers a
   *    message after subscribing is useless. If silent past the verify
   *    window, re-send the subscribe once; if still silent, force reconnect.
   * 2. ZOMBIE SELF-HEAL — a socket that HAS delivered traffic but has gone
   *    silent (no message AND no pong) longer than ZOMBIE_SILENCE_MS is a
   *    half-open connection. Self-heal immediately instead of waiting for
   *    the external watchdog's 90s backstop.
   */
  private superviseCurrentSocket() {
    if (this.stopped || this.ws?.readyState !== WebSocket.OPEN) return
    const now = Date.now()

    // (1) Subscription verification — no traffic ever since subscribe.
    if (this.assetIds.length > 0 && this.subscribeSentAtMs > 0 && this.lastMessageAtMs === 0) {
      const silentFor = now - this.subscribeSentAtMs
      if (silentFor >= SUBSCRIBE_VERIFY_MS) {
        if (!this.resubscribeAttempted) {
          this.resubscribeAttempted = true
          logEvent("warn", `[CLOB ws] no traffic ${(silentFor / 1000).toFixed(0)}s after subscribe — re-sending subscribe`)
          this.subscribe()
        } else {
          this.forceReconnect(`subscription unverified — no traffic ${(silentFor / 1000).toFixed(0)}s after re-subscribe`)
        }
        return
      }
    }

    // (2) Zombie self-heal — had traffic, then went fully silent.
    if (this.lastMessageAtMs > 0) {
      const lastLifeSign = Math.max(this.lastMessageAtMs, this.lastPongAtMs)
      const silentFor = now - lastLifeSign
      if (silentFor >= ZOMBIE_SILENCE_MS) {
        this.forceReconnect(`zombie socket — OPEN but silent ${(silentFor / 1000).toFixed(0)}s (no message/pong)`)
      }
    }
  }

  private scheduleReconnect() {
    this.clearTimers()
    this.ws = null
    if (this.stopped) return
    this.reconnectAttempts++
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private inRange(p: number): boolean {
    return Number.isFinite(p) && p > 0 && p < 1
  }

  /** Parse a market-channel frame (single object or array of them). */
  private handleMessage(text: string) {
    if (!text || text === "PONG") return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    const events = Array.isArray(parsed) ? parsed : [parsed]
    for (const ev of events) {
      if (ev && typeof ev === "object") this.handleEvent(ev as Record<string, unknown>)
    }
  }

  private handleEvent(ev: Record<string, unknown>) {
    const type = ev.event_type as string | undefined
    const now = Date.now()

    if (type === "best_bid_ask") {
      const tokenId = ev.asset_id as string
      const ask = Number(ev.best_ask)
      const bidRaw = Number(ev.best_bid)
      if (tokenId && this.inRange(ask)) {
        this.onUpdate({ tokenId, ask, bid: this.inRange(bidRaw) ? bidRaw : null, atMs: now })
      }
      return
    }

    if (type === "book") {
      const tokenId = ev.asset_id as string
      const asks = ev.asks as Array<{ price?: string | number; size?: string | number }> | undefined
      const bids = ev.bids as Array<{ price?: string | number; size?: string | number }> | undefined
      // The order book is returned worst→best; the best ask is the LOWEST ask
      // price and the best bid is the HIGHEST bid price.
      const bestAsk = this.bestFrom(asks, "min")
      const bestBid = this.bestFrom(bids, "max")
      if (tokenId && bestAsk !== null) {
        this.onUpdate({ tokenId, ask: bestAsk, bid: bestBid, atMs: now })
      }
      // Full snapshot → compute aggregate depth/liquidity for the Signal Tank.
      if (tokenId && this.onBook) {
        const bidStats = this.depthFrom(bids)
        const askStats = this.depthFrom(asks)
        try {
          this.onBook({
            tokenId,
            bidLevels: bidStats.levels,
            askLevels: askStats.levels,
            bidNotionalUsd: bidStats.notionalUsd,
            askNotionalUsd: askStats.notionalUsd,
            atMs: now,
          })
        } catch {
          /* book listener errors must never break the stream */
        }
      }
      return
    }

    if (type === "price_change") {
      const changes = ev.price_changes as Array<Record<string, unknown>> | undefined
      if (!Array.isArray(changes)) return
      for (const c of changes) {
        const tokenId = c.asset_id as string
        const ask = Number(c.best_ask)
        const bidRaw = Number(c.best_bid)
        if (tokenId && this.inRange(ask)) {
          this.onUpdate({ tokenId, ask, bid: this.inRange(bidRaw) ? bidRaw : null, atMs: now })
        }
      }
      return
    }
  }

  /** Aggregate level count and USD notional (price x size) for one book side. */
  private depthFrom(levels: Array<{ price?: string | number; size?: string | number }> | undefined): {
    levels: number
    notionalUsd: number
  } {
    if (!Array.isArray(levels)) return { levels: 0, notionalUsd: 0 }
    let count = 0
    let notional = 0
    for (const lvl of levels) {
      const p = Number(lvl.price)
      const s = Number(lvl.size)
      if (!this.inRange(p) || !Number.isFinite(s) || s <= 0) continue
      count++
      notional += p * s
    }
    return { levels: count, notionalUsd: Math.round(notional * 100) / 100 }
  }

  private bestFrom(levels: Array<{ price?: string | number }> | undefined, pick: "min" | "max"): number | null {
    if (!Array.isArray(levels) || levels.length === 0) return null
    let best: number | null = null
    for (const lvl of levels) {
      const p = Number(lvl.price)
      if (!this.inRange(p)) continue
      if (best === null) best = p
      else if (pick === "min") best = Math.min(best, p)
      else best = Math.max(best, p)
    }
    return best
  }
}
