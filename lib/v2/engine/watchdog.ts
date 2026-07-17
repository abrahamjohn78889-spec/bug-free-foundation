import { logEvent } from "./events"
import type { ClobPriceFeed } from "./feeds/clob-price-feed"
import type { OrderEventListener } from "./feeds/order-events"

/**
 * Watchdog — the self-healing layer for months-long unattended VPS operation.
 *
 * Every CHECK_MS it inspects each long-lived connection and repairs the
 * failure modes that do NOT self-recover through normal event handling:
 *
 *  1. ZOMBIE MARKET WS  — socket reports OPEN but no frame has arrived for
 *     WS_STALE_MS (half-open TCP after an internet blip / NAT timeout /
 *     silent server drop; "close" never fires, so the reconnect-on-close
 *     path never runs). Fix: hard terminate + reconnect.
 *  2. ZOMBIE USER WS    — same failure mode on the authenticated user
 *     channel (PONGs stop arriving). Fix: hard terminate + reconnect.
 *  3. STALE QUOTES      — token IDs are set but no successful REST poll or
 *     WS update for QUOTE_STALE_MS despite the 2s poll timer (e.g. DNS
 *     failure where every fetch throws instantly). Fix: log loudly +
 *     force a WS reconnect (a fresh socket also re-resolves DNS).
 *  4. HEARTBEAT         — records a liveness timestamp + memory snapshot so
 *     the health endpoint (and any external monitor) can detect a wedged
 *     event loop and warn about memory growth.
 *
 * The watchdog is strictly a REPAIR layer: it never places, cancels, or
 * modifies orders, and it never touches trading state.
 */

const CHECK_MS = 30_000
const WS_STALE_MS = 90_000 // market WS: pings every ~10s → 9 misses = dead
const USER_WS_STALE_MS = 60_000 // user WS: PING/PONG every 10s → 6 misses = dead
const QUOTE_STALE_MS = 45_000 // quotes should refresh every ~2s
const MEM_WARN_RSS_MB = 400 // PM2 restarts at 512MB; warn well before
/** SLO tick loop: base cadence is 1s, hot cadence 250ms. If no tick has
 *  COMPLETED for this long while an order is armed, the loop is stalled
 *  (wedged timer chain / permanently-stuck busy flag) → kick it. */
const SLO_STALL_MS = 30_000

export interface WatchdogSnapshot {
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

interface Deps {
  clobPriceFeed: ClobPriceFeed
  getOrderEvents: () => OrderEventListener
  /** Feeds only matter when token IDs are set (a market is being tracked). */
  isTrackingMarket: () => boolean
  /** SLO tick-loop liveness (null when no standing order manager exists). */
  getSloHealth?: () => { active: boolean; paused: boolean; lastTickStartMs: number; lastTickCompletedMs: number } | null
  /** Restart a stalled SLO tick chain (never touches orders — repair only). */
  kickSlo?: (reason: string) => void
}

export class Watchdog {
  private deps: Deps
  private timer: ReturnType<typeof setInterval> | null = null

  private lastCheckAtMs = 0
  private checksRun = 0
  private marketWsReconnects = 0
  private userWsReconnects = 0
  private staleQuoteRecoveries = 0
  private sloLoopRestarts = 0
  private lastSloKickMs = 0
  private lastMemWarnMs = 0
  /** Rate-limit repairs so a genuinely dead network is not hammered. */
  private lastMarketWsRepairMs = 0
  private lastUserWsRepairMs = 0

  constructor(deps: Deps) {
    this.deps = deps
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.check(), CHECK_MS)
    logEvent("info", "[Watchdog] started — WS zombie detection, stale-quote recovery, memory monitoring")
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  snapshot(): WatchdogSnapshot {
    const mem = process.memoryUsage()
    return {
      lastCheckAtMs: this.lastCheckAtMs,
      checksRun: this.checksRun,
      marketWsReconnects: this.marketWsReconnects,
      userWsReconnects: this.userWsReconnects,
      staleQuoteRecoveries: this.staleQuoteRecoveries,
      sloLoopRestarts: this.sloLoopRestarts,
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      uptimeSec: Math.round(process.uptime()),
    }
  }

  private check() {
    try {
      this.lastCheckAtMs = Date.now()
      this.checksRun++
      this.checkMarketWs()
      this.checkUserWs()
      this.checkQuoteStaleness()
      this.checkSloLoop()
      this.checkMemory()
    } catch (e) {
      // The watchdog must never crash the process it is protecting.
      logEvent("warn", `[Watchdog] check failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private checkMarketWs() {
    const now = Date.now()
    const ws = this.deps.clobPriceFeed.wsDiagnostics()
    if (!this.deps.isTrackingMarket() || ws.assetIds.length === 0) return
    if (!ws.connected || ws.lastMessageAtMs === 0) return // reconnect-on-close path owns closed sockets
    const silence = now - ws.lastMessageAtMs
    if (silence > WS_STALE_MS && now - this.lastMarketWsRepairMs > WS_STALE_MS) {
      this.lastMarketWsRepairMs = now
      this.marketWsReconnects++
      this.deps.clobPriceFeed.forceWsReconnect(
        `market WS open but silent for ${(silence / 1000).toFixed(0)}s — zombie socket`,
      )
    }
  }

  private checkUserWs() {
    const now = Date.now()
    const ev = this.deps.getOrderEvents()
    if (!ev.hasScope || !ev.connected) return
    const silence = ev.lastFrameAgeMs
    if (silence > USER_WS_STALE_MS && now - this.lastUserWsRepairMs > USER_WS_STALE_MS) {
      this.lastUserWsRepairMs = now
      this.userWsReconnects++
      ev.forceReconnect(`user WS open but silent for ${(silence / 1000).toFixed(0)}s — zombie socket`)
    }
  }

  private checkQuoteStaleness() {
    if (!this.deps.isTrackingMarket()) return
    const d = this.deps.clobPriceFeed.diagnostics()
    if (!d.upTokenId || !d.downTokenId) return
    const lastData = Math.max(d.lastSuccessMs, 0)
    if (lastData === 0) return // never had data yet — discovery/boot path
    const staleFor = Date.now() - lastData
    if (staleFor > QUOTE_STALE_MS) {
      this.staleQuoteRecoveries++
      logEvent(
        "warn",
        `[Watchdog] quotes stale for ${(staleFor / 1000).toFixed(0)}s (${d.consecutiveFailures} consecutive poll failures: ${d.lastFailReason.slice(0, 120)}) — forcing WS reconnect + immediate poll`,
      )
      // A fresh socket re-resolves DNS and re-subscribes; the poll kick
      // recovers immediately if only the timer path was wedged.
      this.deps.clobPriceFeed.forceWsReconnect("stale-quote recovery")
      this.deps.clobPriceFeed.pollNow()
    }
  }

  /**
   * SLO LOOP LIVENESS: an armed standing order whose tick chain has stopped
   * completing ticks is a silent-death scenario — the dashboard still shows
   * ARMED but nothing is being evaluated. Detect: no tick COMPLETION for
   * SLO_STALL_MS while active and not paused. Repair: kick the loop (epoch
   * bump + busy reset + timer-chain restart). Strictly repair-only — the kick
   * never places, cancels, or modifies orders.
   */
  private checkSloLoop() {
    if (!this.deps.getSloHealth || !this.deps.kickSlo) return
    const h = this.deps.getSloHealth()
    if (!h || !h.active || h.paused) return
    // Never ticked yet (just armed) — measure from arm time via lastTickStartMs.
    const lastLife = Math.max(h.lastTickCompletedMs, h.lastTickStartMs)
    if (lastLife === 0) return
    const now = Date.now()
    const stalledFor = now - lastLife
    if (stalledFor > SLO_STALL_MS && now - this.lastSloKickMs > SLO_STALL_MS) {
      this.lastSloKickMs = now
      this.sloLoopRestarts++
      logEvent(
        "warn",
        `[Watchdog] SLO tick loop STALLED — no tick completed for ${(stalledFor / 1000).toFixed(0)}s while armed; kicking the loop (restart #${this.sloLoopRestarts})`,
      )
      this.deps.kickSlo(`no tick completed for ${(stalledFor / 1000).toFixed(0)}s`)
    }
  }

  private checkMemory() {
    const now = Date.now()
    const rssMb = process.memoryUsage().rss / 1048576
    if (rssMb > MEM_WARN_RSS_MB && now - this.lastMemWarnMs > 10 * 60_000) {
      this.lastMemWarnMs = now
      logEvent(
        "warn",
        `[Watchdog] memory high: RSS ${rssMb.toFixed(0)}MB (PM2 restart threshold 512MB) — investigate if this grows steadily`,
      )
    }
  }
}
