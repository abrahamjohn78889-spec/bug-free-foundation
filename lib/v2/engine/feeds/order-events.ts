import WebSocket from "ws"
import { env } from "../config"
import { logEvent } from "../events"

/**
 * Authenticated User-channel WebSocket listener for Polymarket CLOB.
 *
 * READ-ONLY by design: it observes real-time `order` and `trade` events for
 * the engine's own API key and logs them for visibility / order-state
 * awareness. It does NOT place, cancel, or modify orders, and it does NOT
 * feed the trigger or fill-detection path — actual fills are still detected by
 * the executor's REST `checkFill` polling, which owns ledger creation. Nothing
 * about trading logic, trigger detection, side-locking, standing-order
 * behavior, order execution, or one-order-per-window depends on this listener.
 *
 * Protocol (docs.polymarket.com CLOB websocket user-channel + overview):
 *   • endpoint:   wss://ws-subscriptions-clob.polymarket.com/ws/user
 *   • subscribe:  { auth: { apiKey, secret, passphrase },
 *                   markets: [conditionId, ...], type: "user" }
 *                 (auth travels in the SUBSCRIPTION message, never the URL)
 *   • dynamic:    { markets: [...], operation: "subscribe" | "unsubscribe" }
 *                 (change subscriptions without reconnecting)
 *   • events:     event_type "order"  → PLACEMENT / UPDATE / CANCELLATION
 *                 event_type "trade"  → MATCHED → MINED → CONFIRMED (etc.)
 *   • heartbeat:  send text "PING" every 10s; server replies "PONG"
 *
 * Subscription scope is limited to the markets the engine is ACTIVELY
 * monitoring (by condition ID). `setMarkets` is called on start and on every
 * slot rollover so we only ever receive events for relevant markets. Multiple
 * simultaneously-active markets are supported — pass every active condition ID.
 */

const WS_USER_URL = `${env.CLOB_WS_HOST}/user`
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000
const PING_INTERVAL_MS = 10_000

export class OrderEventListener {
  private ws: WebSocket | null = null
  private stopped = true
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** Condition IDs the engine is actively monitoring (subscription scope). */
  private markets: string[] = []
  /** Last time ANY frame (including PONG) arrived — zombie-socket detection. */
  private lastFrameAtMs = 0
  /**
   * Optional observer invoked (with the event type) whenever a live order or
   * trade event arrives. Used by the engine to trigger a debounced account
   * refresh so the dashboard mirror stays in sync. Read-only: it must never
   * influence trading logic.
   */
  private onAccountEvent: ((eventType: "order" | "trade") => void) | null = null

  constructor() {}

  /** Register (or clear) the account-event observer. */
  setOnAccountEvent(cb: ((eventType: "order" | "trade") => void) | null): void {
    this.onAccountEvent = cb
  }

  /** True once the socket is open. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** Ms since the last frame (any, incl. PONG) arrived; Infinity if never. */
  get lastFrameAgeMs(): number {
    return this.lastFrameAtMs === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastFrameAtMs
  }

  /** Whether this listener currently has an active subscription scope. */
  get hasScope(): boolean {
    return this.markets.length > 0 && !this.stopped
  }

  /**
   * ZOMBIE-SOCKET RECOVERY: hard-kill and reopen a socket that reports OPEN
   * but has stopped delivering frames (PONGs stop on a half-open TCP path).
   */
  forceReconnect(reason: string): void {
    if (this.stopped) return
    logEvent("warn", `[OrderEvents] force reconnect: ${reason}`)
    this.clearTimers()
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.terminate()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.open()
  }

  /**
   * Declare which markets (condition IDs) the engine is actively monitoring.
   * Diffs against the current scope and, while connected, sends dynamic
   * subscribe/unsubscribe deltas WITHOUT reconnecting. Opens the socket lazily
   * the first time a non-empty scope is provided. Cheap no-op if unchanged.
   */
  setMarkets(conditionIds: string[]): void {
    const next = Array.from(new Set(conditionIds.filter(Boolean))).sort()
    const prev = this.markets
    const unchanged = next.length === prev.length && next.every((id, i) => id === prev[i])
    if (unchanged) return

    const added = next.filter((id) => !prev.includes(id))
    const removed = prev.filter((id) => !next.includes(id))
    this.markets = next

    // Credentials are required for the user channel; without them we never
    // connect (the live engine validates creds before start, so this is just
    // a safety guard).
    if (!this.hasCredentials()) return

    if (this.stopped || !this.ws) {
      // Lazily open the connection now that we have a scope to subscribe to.
      if (next.length > 0) this.connect()
      return
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      // Adjust the live subscription in place — no reconnect.
      if (added.length) this.sendOperation(added, "subscribe")
      if (removed.length) this.sendOperation(removed, "unsubscribe")
    }
  }

  /** Open the connection. Idempotent while a socket already exists. */
  connect(): void {
    if (this.ws) return
    if (!this.hasCredentials()) {
      logEvent("warn", "[OrderEvents] Missing CLOB API credentials — user channel disabled")
      return
    }
    this.stopped = false
    this.open()
  }

  close(): void {
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

  // ---------- internals ----------

  private hasCredentials(): boolean {
    return Boolean(env.POLY_API_KEY && env.POLY_API_SECRET && env.POLY_API_PASSPHRASE)
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private open(): void {
    if (this.stopped) return
    try {
      const ws = new WebSocket(WS_USER_URL)
      this.ws = ws

      ws.on("open", () => {
        this.reconnectAttempts = 0
        this.subscribeAll()
        // Application-level keepalive: the server drops idle sockets after ~10s.
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send("PING")
            } catch {
              /* ignore */
            }
          }
        }, PING_INTERVAL_MS)
        logEvent("info", "[OrderEvents] User channel connected")
      })

      ws.on("open", () => {
        this.lastFrameAtMs = Date.now()
      })
      ws.on("message", (raw: WebSocket.RawData) => {
        this.lastFrameAtMs = Date.now()
        this.handleMessage(raw.toString())
      })
      ws.on("close", () => this.scheduleReconnect())
      ws.on("error", (err: Error) => {
        // A close event follows; log once and let reconnect handle recovery.
        logEvent("warn", `[OrderEvents] User channel error: ${err.message}`)
      })
    } catch (e) {
      logEvent("warn", `[OrderEvents] Connection failed: ${e instanceof Error ? e.message : String(e)}`)
      this.scheduleReconnect()
    }
  }

  /** Send the full authenticated subscription for the current market scope. */
  private subscribeAll(): void {
    if (this.ws?.readyState !== WebSocket.OPEN || this.markets.length === 0) return
    const msg = {
      auth: {
        apiKey: env.POLY_API_KEY,
        secret: env.POLY_API_SECRET,
        passphrase: env.POLY_API_PASSPHRASE,
      },
      markets: this.markets,
      type: "user",
    }
    try {
      this.ws.send(JSON.stringify(msg))
    } catch (e) {
      logEvent("warn", `[OrderEvents] Subscribe failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Send a dynamic subscribe/unsubscribe delta for a set of condition IDs. */
  private sendOperation(conditionIds: string[], operation: "subscribe" | "unsubscribe"): void {
    if (this.ws?.readyState !== WebSocket.OPEN || conditionIds.length === 0) return
    try {
      this.ws.send(JSON.stringify({ markets: conditionIds, operation }))
    } catch (e) {
      logEvent("warn", `[OrderEvents] ${operation} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private scheduleReconnect(): void {
    this.clearTimers()
    this.ws = null
    if (this.stopped) return
    this.reconnectAttempts++
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => this.open(), delay)
  }

  private handleMessage(text: string): void {
    // Heartbeat replies and empty frames carry no event payload.
    if (!text || text === "PONG" || text === "PING") return
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

  private handleEvent(ev: Record<string, unknown>): void {
    const eventType = ev.event_type as string | undefined
    if (eventType === "trade") {
      this.logTrade(ev)
      this.onAccountEvent?.("trade")
    } else if (eventType === "order") {
      this.logOrder(ev)
      this.onAccountEvent?.("order")
    }
    // Any other event types are ignored (read-only observer).
  }

  /**
   * Log a trade lifecycle update. Direction comes from the market `outcome`
   * field (e.g. "Up"/"Down" or "Yes"/"No") — NOT from BUY/SELL, which only
   * describes order side and does not identify the outcome token.
   */
  private logTrade(ev: Record<string, unknown>): void {
    const outcome = (ev.outcome as string | undefined) ?? "?"
    const status = (ev.status as string | undefined) ?? "?"
    const side = (ev.side as string | undefined) ?? "?"
    const size = Number(ev.size ?? 0)
    const price = Number(ev.price ?? 0)
    const tradeId = (ev.id as string | undefined) ?? ""
    const idTag = tradeId ? ` (trade ${tradeId.slice(0, 8)})` : ""
    logEvent(
      "info",
      `[OrderEvents] trade ${status}: ${side} ${size} ${outcome} @ $${price.toFixed(2)}${idTag}`,
    )
  }

  /** Log an order lifecycle update (placement / partial match / cancellation). */
  private logOrder(ev: Record<string, unknown>): void {
    const type = (ev.type as string | undefined) ?? "?"
    const outcome = (ev.outcome as string | undefined) ?? "?"
    const side = (ev.side as string | undefined) ?? "?"
    const originalSize = Number(ev.original_size ?? 0)
    const sizeMatched = Number(ev.size_matched ?? 0)
    const price = Number(ev.price ?? 0)
    const orderId = (ev.id as string | undefined) ?? ""
    const idTag = orderId ? ` (order ${orderId.slice(0, 8)})` : ""
    logEvent(
      "info",
      `[OrderEvents] order ${type}: ${side} ${outcome} matched ${sizeMatched}/${originalSize} @ $${price.toFixed(2)}${idTag}`,
    )
  }
}

// Singleton instance — the engine drives connection via setMarkets().
let listener: OrderEventListener | null = null

export function getOrderEventListener(): OrderEventListener {
  if (!listener) {
    listener = new OrderEventListener()
  }
  return listener
}

export function closeOrderEventListener() {
  if (listener) {
    listener.close()
    listener = null
  }
}
