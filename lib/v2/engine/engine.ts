// Side-effect import: installs the tuned keep-alive HTTP dispatcher for the
// whole process before any feed makes a fetch. Must be first.
import "./http-agent"
// Side-effect: patches global fetch + WS to route through HTTPS_PROXY or SOCKS5_PROXY
// when set in .env. No-op when env vars are absent.
import { applyGlobalProxyPatch } from "./proxy"
applyGlobalProxyPatch()
import { startTrace, recordPoint, completeTrace } from "./latency-trace"
import { Bankroll } from "./bankroll"
import { clockOffsetMs, clockSynced, currentSlotEndMs, marketIdForSlot, startClockSync, tMinusMs } from "./clock"
import { DEFAULT_STRATEGY, SLOT_MS, clampBand, env } from "./config"
import { clearLedger, closeOrphanedOpenTrades, feedStats, insertOrderLog, insertTrade, kvGet, kvSet, runDbMaintenance, tradeStats } from "./db"
import { logEvent, recentEvents } from "./events"
import { PaperExecutor } from "./execution/paper"
import type { Executor } from "./execution/executor"
import { MarketDiscovery, type DiscoveredMarket } from "./feeds/market-discovery"
import { makeBtcReferenceFeed } from "./feeds/btc-reference-feed"
import { ClobPriceFeed } from "./feeds/clob-price-feed"
import { getOrderEventListener, closeOrderEventListener } from "./feeds/order-events"
import { AccountSync } from "./feeds/account-sync"
import { tokenPrices } from "./market-model"
import { phaseFor } from "./strategy/sniper"
import { evaluateOracleGuard } from "./handlers/oracle-sync-guard"
import { classifyCancelReplace } from "./handlers/cancel-replace-pipeline"
import { validateOrderSize } from "./handlers/protocol-validator"
import { buildOrphanCounter, detectOrphan } from "./handlers/orphan-cleaner"
import { allDefaultParams, defaultParamsFor, getStrategy, isStrategyId } from "./strategy-registry/registry"
import { Reconciler } from "./reconciler"
import { FillReconciler } from "./fill-reconciler"
import { startAccountingVerifier, stopAccountingVerifier, getLastAccountingAudit } from "./accounting-verifier"
import { stopSettlementVerifier } from "./settlement-verifier"
import { RiskManager, type RiskLimits } from "./risk"
import { Watchdog } from "./watchdog"
import { StandingOrderManager } from "./standing-order"
import { getTelegram } from "./telegram"
import { initNotifier, notify } from "./notifier"
import type { EnginePhase, EngineSnapshot, OpenOrder, PipelineMode, SloSizingMode, StrategyConfig, StrategyId, StrategyParams, TIF, TradeSide, TriggerMode } from "./types"

// ------------------------------------------------------------
// Edge 5 Engine — the orchestrator singleton.
// Runs a 50ms decision loop over the NTP-synced candle clock,
// pipes sniper decisions into the hot-swappable executor, and
// settles/compounds at every 5-minute expiry.
// ------------------------------------------------------------

// --- Settlement resolution (single source of truth = official Polymarket) ---
// Official Chainlink-resolved outcome is polled with backoff before ANY
// win/loss is committed, in BOTH paper and live modes. A LOCAL spot heuristic
// is only a strict last-resort fallback; unverifiable candles settle SCRATCH.
// 20 × 3s = 60s of patience — Gamma's closed flag flips ~15-30s post-close.
const RESOLUTION_ATTEMPTS = 20
const RESOLUTION_POLL_MS = 3_000
// $1 was inside spot-vs-Chainlink noise (see trade ecac0be7 forensics); a
// fallback winner now requires a genuinely decisive $20 move, else SCRATCH.
const FALLBACK_MIN_MARGIN_USD = 20

interface FilledPosition {
  side: TradeSide
  price: number
  shares: number
  cost: number
  dust: number
  marketId: string
  slotEndMs: number
}

export class Edge5Engine {
  // V2 stack is pinned to live trading. This engine copy lives in lib/v2
  // and is fully independent from the V1 (paper) stack in lib/v1.
  mode: PipelineMode = "LIVE_V2"

  /** Namespace a shared kv key to THIS stack so V1 and V2 never collide in the
   *  shared sqlite kv table (trades are already namespaced by the mode column). */
  private nsKey(key: string): string {
    return `${key}:${this.mode}`
  }
  running = false
  cfg: StrategyConfig = { ...DEFAULT_STRATEGY, p1Band: { ...DEFAULT_STRATEGY.p1Band }, p2Band: { ...DEFAULT_STRATEGY.p2Band } }

  // BTC reference price feed (Chainlink, display + paper-settlement only).
  // Contract prices come exclusively from the Polymarket CLOB feed below.
  private spotFeed = makeBtcReferenceFeed()
  private clobPriceFeed = new ClobPriceFeed()
  private discovery = new MarketDiscovery()
  private market: DiscoveredMarket | null = null
  private executor: Executor | null = null
  private loop: ReturnType<typeof setInterval> | null = null
  private busy = false
  /**
   * LIVE_V2 read-only account mirror (balance/orders/trades/positions/value).
   * Null in PAPER_V1. Populated lazily when the live executor is built.
   */
  private accountSync: AccountSync | null = null

  private slotEndMs = 0
  private strike: number | null = null
  /**
   * ROLLOVER BARRIER — the engine's market-transition state machine.
   * At every slot rollover the engine enters ROLLING_OVER and stays there
   * until ALL of the following hold for the NEW slot:
   *   1. the new market is discovered (this.market matches this.slotEndMs)
   *   2. token ids are verified (pushed into the price feed → new generation)
   *   3. the websocket is subscribed to the new tokens
   *   4. the first VALIDATED quote pair of the new generation has arrived
   * While ROLLING_OVER, no strategy decision or fill evaluation runs — the
   * engine can never trade the gap between two markets on leftover state.
   * Starts as ROLLING_OVER: a freshly-ignited engine must also prove the
   * pipeline end-to-end before its first decision.
   */
  private rolloverState: "LIVE" | "ROLLING_OVER" = "ROLLING_OVER"
  private rolloverStartedAtMs = 0
  private lastRolloverLogMs = 0
  private openOrder: OpenOrder | null = null
  private position: FilledPosition | null = null
  private lastCancelReplaceMs: number | null = null
  private lastReason = ""
  private pendingResolutions = 0
  private lastTickErrorMsg = ""
  private lastTickErrorAtMs = 0
  private lastTickStartMs = 0

  bankroll = new Bankroll(this.mode)

  /** Mandatory pre-order risk gate — kill switch, daily-loss breaker,
   *  notional/order-rate caps, price + share sanity. Both order paths
   *  (registry strategy and standing limit order) route through it. */
  readonly risk = new RiskManager(() => this.mode)

  /** Read-only exchange-truth reconciler (LIVE_V2, runs while ignited).
   *  Flags untracked live orders, missing tracked orders, wallet drift. */
  private reconciler = new Reconciler({
    getExecutor: () => this.executor,
    getTrackedOrders: () => {
      const tracked: OpenOrder[] = []
      if (this.openOrder) tracked.push(this.openOrder)
      const slo = this.standingOrders?.trackedRestingOrder
      if (slo) tracked.push(slo)
      return tracked
    },
    getLocalBalanceUsd: () => this.bankroll.balance,
    // Both pipelines reconcile against their execution backend's account
    // mirror (real exchange in LIVE_V2, simulated exchange in PAPER_V1).
    isLive: () => true,
    isRunning: () => this.running,
  })

  /** Read-only end-to-end CLOB fill ↔ ledger cross-check (60s cadence).
   *  Surfaces UNBOOKED / UNATTRIBUTED / DUPLICATE / ORPHAN drift as
   *  order_log ERROR entries. Never mutates orders or ledger rows. */
  private fillReconciler = new FillReconciler({
    getExecutor: () => this.executor,
    getMode: () => this.mode,
    isRunning: () => this.running,
  })

  /**
   * Independent standing limit order subsystem. Runs on its own loop,
   * fully decoupled from this engine's tick loop, the Time Window /
   * phase machine, and the strategy path. Instantiated in the constructor.
   */
  private standingOrders!: StandingOrderManager

  /** Self-healing watchdog (process-lifetime; started in the constructor). */
  watchdog!: Watchdog

  /** The registry edge currently routed into the pipeline. Null means no strategy is active. */
  get activeStrategy(): StrategyId | null {
    return this.cfg.activeStrategy
  }

  constructor() {
    // Restore the persisted pipeline mode FIRST — everything below (orphan
    // cleanup namespace, bankroll, standing orders) depends on it. A restart
    // must never flip a PAPER_V1 session into LIVE_V2 real-money mode.
    // Legacy migration: sessions persisted as "SHADOW_V2" (the retired
    // validation pipeline) map onto PAPER_V1, its direct successor.
    let savedMode = kvGet("v2:pipeline-mode")
    if (savedMode === "SHADOW_V2") {
      savedMode = "PAPER_V1"
      kvSet("v2:pipeline-mode", savedMode)
    }
    if (savedMode === "LIVE_V2" || savedMode === "PAPER_V1") {
      this.mode = savedMode
      if (this.mode === "PAPER_V1") {
        this.bankroll = new Bankroll(this.mode)
        if (this.bankroll.startingBalance === 0) this.bankroll.reset(env.PAPER_STARTING_BALANCE)
      }
    }
    startClockSync()
    // Restart recovery: any ledger row still OPEN belongs to a previous
    // process whose in-memory position was lost — it can never be settled by
    // the normal path. Close them as SCRATCH so history never leaks
    // permanently-open rows across crashes/PM2 restarts/deploys.
    closeOrphanedOpenTrades()
    this.spotFeed.start()
    this.clobPriceFeed.start()
    // Standing limit order runs independently of the strategy engine.
    this.standingOrders = new StandingOrderManager({
      getMode: () => this.mode,
      getBankroll: () => this.bankroll,
      discovery: this.discovery,
      clobPriceFeed: this.clobPriceFeed,
      spotFeed: this.spotFeed,
      risk: this.risk,
    })
    // Seed per-edge params from the registry before restoring any
    // persisted overrides (keeps config decoupled from the registry).
    this.cfg.strategyParams = allDefaultParams()
    this.restoreConfig()
    if (this.bankroll.startingBalance === 0 && this.mode === "PAPER_V1") {
      this.bankroll.reset(env.PAPER_STARTING_BALANCE)
    }
    getTelegram(this)
    // One-way operations notifier (category-gated Telegram push). Separate
    // from the interactive control bot above; boot-once via global singleton.
    initNotifier()
    // Self-healing layer: zombie-WS detection, stale-quote recovery, memory
    // monitoring. Lives for the process lifetime (the feeds it protects start
    // in this constructor and also run regardless of ignition state).
    this.watchdog = new Watchdog({
      clobPriceFeed: this.clobPriceFeed,
      getOrderEvents: () => getOrderEventListener(),
      isTrackingMarket: () => this.clobPriceFeed.diagnostics().upTokenId !== null,
      // SLO tick-loop liveness: detects a wedged timer chain / permanently
      // stuck busy flag while an order is armed, and restarts it (repair
      // only — the kick never touches order state).
      getSloHealth: () => this.standingOrders?.getLoopHealth() ?? null,
      kickSlo: (reason) => this.standingOrders?.kickLoop(reason),
    })
    this.watchdog.start()
    // DB hygiene for months-long operation: prune old order_log rows and
    // truncate the WAL once a day (runs shortly after boot, then every 24h).
    this.dbMaintenanceTimer = setInterval(() => this.runDbMaintenanceSafe(), 24 * 3_600_000)
    // Tracked so dispose() before the 60s mark can't fire a late maintenance
    // pass (a synchronous VACUUM INTO) against a torn-down engine.
    this.dbKickoffTimer = setTimeout(() => this.runDbMaintenanceSafe(), 60_000)
    logEvent("info", `Edge 5 engine initialized in ${this.mode} (bot stopped, awaiting ignition)`)
    this.maybeAutoResume()
  }

  private dbMaintenanceTimer: ReturnType<typeof setInterval> | null = null
  private dbKickoffTimer: ReturnType<typeof setTimeout> | null = null

  private runDbMaintenanceSafe() {
    try {
      logEvent("info", `[DB] maintenance: ${runDbMaintenance()}`)
    } catch (e) {
      logEvent("warn", `[DB] maintenance failed: ${(e as Error).message}`)
    }
  }

  /**
   * Daemon resilience: if the process died (PM2 restart, deploy,
   * crash) while the bot was running, re-arm automatically after a
   * short grace period so the feeds and clock have time to connect.
   */
  private maybeAutoResume() {
    if (kvGet(this.nsKey("engine:running")) !== "1") return
    logEvent("warn", "Previous session was running — auto-resuming ignition in 5s (PM2 restart recovery)")
    setTimeout(() => {
      if (!this.running) {
        const msg = this.start()
        logEvent("info", `Auto-resume: ${msg}`)
      }
    }, 5_000)
  }

  // ---------- persistence of runtime config ----------

  private restoreConfig() {
    const seededParams = this.cfg.strategyParams
    const saved = kvGet(this.nsKey("strategy:config"))
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Partial<StrategyConfig>
        this.cfg = { ...this.cfg, ...parsed }
        // Deep-merge params so newly-added edges/params keep their
        // registry defaults even when an older config was persisted.
        const merged = { ...seededParams }
        for (const id of Object.keys(seededParams) as StrategyId[]) {
          merged[id] = { ...seededParams[id], ...(parsed.strategyParams?.[id] ?? {}) }
        }
        this.cfg.strategyParams = merged
      } catch {
        /* keep defaults */
      }
    }
    // activeStrategy === null is the INTENDED default: no registry edge is
    // routed into the pipeline and only the Standing Limit Order (primary,
    // highest-priority engine) runs. NEVER auto-activate a strategy here.
    // Only sanitize genuinely-invalid non-null persisted values back to null.
    if (this.cfg.activeStrategy !== null && !isStrategyId(this.cfg.activeStrategy)) {
      this.cfg.activeStrategy = null
    }
    // One-time recovery: a previous build force-activated "edge5"
    // (Meta-Cognitive Cascading Sniper) on every restart via a now-removed
    // coercion, and that polluted value was persisted to the KV store. Clear it
    // exactly once so the app recovers to the Standing-Limit-Order-only default.
    // Future explicit user selections still persist and are respected on restart.
    if (kvGet(this.nsKey("migration:clear-forced-edge5")) !== "1") {
      if (this.cfg.activeStrategy !== null) {
        logEvent(
          "info",
          `Cleared auto-activated strategy "${this.cfg.activeStrategy}" — Standing Limit Order is the default, highest-priority engine`,
        )
        this.cfg.activeStrategy = null
      }
      kvSet(this.nsKey("migration:clear-forced-edge5"), "1")
      this.persistConfig()
    }
  }

  private persistConfig() {
    kvSet(this.nsKey("strategy:config"), JSON.stringify(this.cfg))
  }

  // ---------- public controls ----------

  start(): string {
    if (this.running) return "Already running"
    try {
      this.executor = this.buildExecutor()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logEvent("error", msg)
      return msg
    }
    // Clear any hung busy flag from a previous session so the loop can
    // fire immediately without waiting for a ghost promise to resolve.
    this.busy = false
    this.running = true
    this.slotEndMs = currentSlotEndMs()
    this.strike = null
    this.market = null
    // Fresh ignition must prove the full pipeline (discovery → tokens → WS →
    // first validated quote pair) before the first decision, exactly like a
    // slot rollover does.
    this.rolloverState = "ROLLING_OVER"
    this.rolloverStartedAtMs = Date.now()
    this.armMarket(this.slotEndMs)
    // Both pipelines: fetch the wallet balance on boot so the dashboard shows
    // collateral immediately (fire-and-forget; never blocks ignition). In
    // PAPER_V1 the executor answers with the simulated wallet while every
    // read still exercises the identical code path as LIVE_V2.
    {
      void this.syncLiveBalance()
      // Point the authenticated User-channel listener at the market we're now
      // actively monitoring. It observes real-time order/trade events for
      // logging only — fills are still detected by checkFill REST polling.
      getOrderEventListener().setMarkets(this.activeConditionIds())
      // Read-only account mirror: assemble live Polymarket account data
      // (balance/orders/trades/positions/value/PnL) for the dashboard. Wired
      // to the User-channel WS so order/trade events trigger a debounced
      // refresh. Fully decoupled from trading — never touches the tick loop.
      if (this.executor) {
        const sync = new AccountSync(this.executor)
        this.accountSync = sync
        getOrderEventListener().setOnAccountEvent(() => sync.requestRefresh("ws"))
        sync.start()
      }
      // Exchange-truth reconciler: read-only 60s cross-check of open orders
      // and wallet vs the engine's local view. Flags untracked live orders.
      this.reconciler.start()
      this.fillReconciler.start()
      // Continuous accounting verifier (Phase 5): pure-math ledger identities
      // (per-trade PnL, balance chain, bankroll agreement, sizing conformance)
      // every 5 minutes in BOTH modes. Report-only except bankroll re-stamp.
      startAccountingVerifier(
        () => this.mode,
        {
          getBankroll: () => this.bankroll,
          getOpenCostUsd: () => this.standingOrders?.getOpenCostUsd() ?? 0,
          getConfiguredShares: () => this.standingOrders?.getConfiguredSizing() ?? null,
        },
      )
    }
    this.loop = setInterval(() => void this.tick(), 50)
    kvSet(this.nsKey("engine:running"), "1")
    kvSet("engine:mode", this.mode)
    logEvent("info", `Ignition ON — ${this.mode} pipeline armed`, "engine")
    notify("lifecycle", "ENGINE IGNITED", `Pipeline: ${this.mode}\nBankroll: $${this.bankroll.balance.toFixed(2)}`)
    return `Bot started (${this.mode})`
  }

  stop(): string {
    if (!this.running) return "Already stopped"
    this.running = false
    if (this.loop) clearInterval(this.loop)
    this.loop = null
    const order = this.openOrder
    this.openOrder = null
    if (order && this.executor) {
      void this.executor.cancelOrder(order).catch(() => {})
    }
    // Stop the read-only account mirror timers (cache is retained for display).
    getOrderEventListener().setOnAccountEvent(null)
    this.accountSync?.stop()
    this.reconciler.stop()
    this.fillReconciler.stop()
    stopAccountingVerifier()
    // Close the WebSocket connection for order fill events
    closeOrderEventListener()
    kvSet(this.nsKey("engine:running"), "0")
    logEvent("info", "Ignition OFF — all resting orders dropped", "engine")
    notify("lifecycle", "ENGINE STOPPED", `Pipeline: ${this.mode}`)
    return "Bot stopped"
  }

  /**
   * Full teardown of ALL interval loops owned by this engine instance — the
   * main strategy loop, the independent StandingOrderManager loop, and the CLOB
   * price feed poll timer. Called only when this singleton is being discarded
   * (HMR/version rebuild) so no orphaned setInterval keeps running against the
   * shared price feed and ledger. An orphaned SLO loop was causing duplicate
   * fills and direction-lock flapping alongside the new instance.
   */
  dispose(): void {
    try {
      this.stop()
    } catch {
      /* ignore */
    }
    try {
      this.standingOrders.dispose()
    } catch {
      /* ignore */
    }
    try {
      this.clobPriceFeed.stop()
    } catch {
      /* ignore */
    }
    try {
      this.spotFeed.stop()
    } catch {
      /* ignore */
    }
    try {
      this.watchdog.stop()
    } catch {
      /* ignore */
    }
    if (this.dbMaintenanceTimer) {
      clearInterval(this.dbMaintenanceTimer)
      this.dbMaintenanceTimer = null
    }
    if (this.dbKickoffTimer) {
      clearTimeout(this.dbKickoffTimer)
      this.dbKickoffTimer = null
    }
    // CERTIFICATION FIX (Phase 6): the settlement verifier's module-level
    // interval holds closures over THIS instance's getMode/executor. Because
    // startSettlementVerifier is idempotent (`if (timer) return`), a new
    // engine instance created after HMR/version rebuild could NOT replace the
    // stale closure — the old disposed instance kept running the sweeps and
    // receiving the wallet-mirror credits. Stop it here so the replacement
    // instance's start call re-registers with fresh closures.
    stopSettlementVerifier()
  }

  setMode(mode: PipelineMode): string {
    if (this.running) return "Stop the bot before switching pipelines"
    this.mode = mode
    // SAFETY: persist under a GLOBAL key (nsKey is namespaced by mode — a
    // chicken-and-egg trap). Without this, a PM2 restart mid-paper-session
    // would silently flip the engine back to LIVE_V2 real-money mode.
    kvSet("v2:pipeline-mode", mode)
    this.bankroll = new Bankroll(mode)
    if (mode === "PAPER_V1" && this.bankroll.startingBalance === 0) {
      // Paper ledger is separate from live: seed simulated collateral so the
      // full order lifecycle (debit on fill, credit on settle) can run.
      this.bankroll.reset(env.PAPER_STARTING_BALANCE)
    }
    this.standingOrders.onModeChanged()
    logEvent("info", `Pipeline hot-swapped to ${mode}`)
    return `Environment set to ${mode}`
  }

  setPaperBalance(amount: number): string {
    if (this.mode !== "PAPER_V1") return "Balance can only be set in PAPER_V1"
    if (!(amount > 0)) return "Amount must be positive"
    this.bankroll.reset(amount)
    logEvent("info", `Paper bankroll reset to $${amount.toFixed(2)}`)
    return `Paper balance set to $${amount.toFixed(2)}`
  }

  setBands(p1: { min: number; max: number } | null, p2: { min: number; max: number } | null): string {
    if (p1) this.cfg.p1Band = clampBand(p1.min, p1.max)
    if (p2) this.cfg.p2Band = clampBand(p2.min, p2.max)
    this.persistConfig()
    logEvent(
      "info",
      `Target matrix updated live: P1 $${this.cfg.p1Band.min}-$${this.cfg.p1Band.max}, P2 $${this.cfg.p2Band.min}-$${this.cfg.p2Band.max}`,
    )
    return "Cascade bands updated"
  }

  setDriftPadding(usd: number): string {
    this.cfg.driftPaddingUsd = Math.max(0, usd)
    this.persistConfig()
    return `Drift guard padding set to $${this.cfg.driftPaddingUsd}`
  }

  setTif(tif: TIF): string {
    const valid: TIF[] = ["1m", "2m", "GTC"]
    if (!valid.includes(tif)) return `Invalid TIF: ${tif}. Must be one of 1m, 2m, GTC`
    this.cfg.tif = tif
    this.persistConfig()
    return `Time-In-Force set to ${tif}`
  }

  setP1Window(windowMs: number): string {
    if (windowMs < 0) return "P1 window must be >= 0 (0 disables time windows)"
    if (windowMs > 300_000) return "P1 window must be <= 300 seconds"
    this.cfg.p1WindowMs = Math.floor(windowMs)
    this.persistConfig()
    const label = windowMs === 0 ? "disabled (no time window)" : `${(windowMs / 1000).toFixed(1)}s`
    logEvent("info", `P1 window set to ${label}`)
    return `P1 window set to ${label}`
  }

  setPriceRange(floor: number, ceil: number): string {
    const lo = Math.round(Math.min(Math.max(floor, 0.01), 0.98) * 100) / 100
    const hi = Math.round(Math.min(Math.max(ceil, lo + 0.01), 0.99) * 100) / 100
    this.cfg.priceFloor = lo
    this.cfg.priceCeil = hi
    this.persistConfig()
    return `Price range set to $${lo.toFixed(2)} – $${hi.toFixed(2)}`
  }

  setStrategy(id: StrategyId | null): string {
    if (id === null) {
      if (this.running) return "Stop the bot before clearing the active strategy"
      this.cfg.activeStrategy = null
      this.persistConfig()
      logEvent("info", "Active strategy cleared — Standing Limit Order can run standalone")
      return "Active strategy cleared — only Standing Limit Order will execute"
    }
    if (!isStrategyId(id)) return `Unknown strategy: ${id}`
    if (this.running) return "Stop the bot before switching strategies"
    this.cfg.activeStrategy = id
    if (!this.cfg.strategyParams[id]) this.cfg.strategyParams[id] = defaultParamsFor(id)
    this.persistConfig()
    const meta = getStrategy(id).meta
    logEvent("info", `Active edge switched → ${meta.code}: ${meta.name}`)
    return `Active strategy set to ${meta.code}`
  }

  setStrategyParams(id: StrategyId, params: StrategyParams): string {
    if (!isStrategyId(id)) return `Unknown strategy: ${id}`
    this.cfg.strategyParams[id] = { ...defaultParamsFor(id), ...this.cfg.strategyParams[id], ...params }
    this.persistConfig()
    logEvent("info", `${getStrategy(id).meta.code} parameters updated live`)
    return `${getStrategy(id).meta.code} config applied`
  }

  /**
   * Arm the independent standing limit order. It races the UP and DOWN
   * contracts; the first side whose live best-ask reaches the trigger locks
   * the direction, and a single LIMIT BUY at the target is placed on that side
   * (one order per 5-minute window). Completely independent of engine ignition
   * and the Time Window.
   */
  setLimitOrder(
    limitPrice: number,
    shares: number,
    minPrice?: number,
    maxPrice?: number,
    triggerPrice?: number,
    triggerMode?: TriggerMode,
    opts?: { sizingMode?: SloSizingMode; sizeValue?: number; entryWindowSec?: number | null },
  ): string {
    return this.standingOrders.arm(
      limitPrice,
      shares,
      this.cfg.minShares,
      minPrice,
      maxPrice,
      triggerPrice,
      triggerMode,
      opts,
    )
  }

  clearLimitOrder(): string {
    return this.standingOrders.cancel()
  }

  pauseLimitOrder(): string {
    return this.standingOrders.pause()
  }

  resumeLimitOrder(): string {
    return this.standingOrders.resume()
  }

  /**
   * EMERGENCY STOP — engage the kill switch, cancel every resting order this
   * process knows about, then issue an account-wide cancelAll as the backstop.
   * The switch persists in the DB, so nothing trades again (even across
   * restarts) until the operator explicitly disengages it.
   */
  engageKillSwitch(reason?: string): string {
    this.risk.engageKillSwitch(reason?.trim() || "operator emergency stop", "OPERATOR")
    // Best-effort flatten: SLO resting order + strategy resting order + cancelAll.
    this.standingOrders.pause()
    const stale = this.openOrder
    this.openOrder = null
    if (stale && this.executor) {
      void this.executor.cancelOrder(stale).catch((e) =>
        logEvent("error", `[RISK] kill switch: strategy order cancel failed: ${(e as Error).message}`),
      )
    }
    if (this.executor?.cancelAllOrders) {
      void this.executor.cancelAllOrders().catch((e) =>
        logEvent("error", `[RISK] kill switch: account cancelAll failed: ${(e as Error).message}`),
      )
    }
    return "KILL SWITCH ENGAGED — all order placement blocked, resting orders cancelled. Standing order paused; disengage + resume to trade again."
  }

  disengageKillSwitch(): string {
    if (!this.risk.killSwitch.engaged) return "Kill switch is not engaged"
    this.risk.disengageKillSwitch()
    return "Kill switch disengaged — trading re-enabled (standing order remains paused until resumed)"
  }

  setRiskLimits(limits: Partial<RiskLimits>): string {
    const next = this.risk.setLimits(limits)
    return `Risk limits updated: daily loss $${next.maxDailyLossUsd}, order notional $${next.maxOrderNotionalUsd}, daily orders ${next.maxDailyOrders}, max shares ${next.maxSharesPerOrder}`
  }

  /**
   * Clear all trade + order history for the current pipeline mode and reset
   * the in-memory position/counters. Cancels any resting standing order first
   * so there is no live lot pointing at a now-deleted ledger row.
   */
  resetLedger(): string {
    this.standingOrders.cancel()
    const removed = clearLedger(this.mode)
    logEvent("info", `Ledger reset: cleared ${removed} ${this.mode} trade(s) and order history`)
    return `Ledger reset — cleared ${removed} ${this.mode} trade${removed === 1 ? "" : "s"}`
  }

  /**
   * The ONE interchangeable execution backend of the shared engine:
   *   PAPER_V1 → simulated execution (live CLOB data, intercepted submission)
   *   LIVE_V2  → real Polymarket execution (wallet → SDK → CLOB)
   * Everything upstream of this seam is identical in both modes.
   */
  private buildExecutor(): Executor {
    if (this.mode === "LIVE_V2") {
      // Lazy import keeps live wallet code entirely out of the paper path.
      const { LiveExecutor } = require("./execution/live") as typeof import("./execution/live")
      return new LiveExecutor()
    }
    // Full pipeline with the exchange submission intercepted. Fill decisions
    // read the LIVE CLOB best-ask; nothing can reach Polymarket.
    return new PaperExecutor((side) => this.livePriceForSide(side))
  }

  /** LIVE CLOB best-ask for a side from ONE atomic validated snapshot, or
   *  null when no validated snapshot exists or its confidence is LOW. This is
   *  the paper executor's ONLY fill-decision input — generation-gated,
   *  identity-verified, freshness-checked real data. */
  private livePriceForSide(side: TradeSide): number | null {
    const snap = this.clobPriceFeed.validatedQuotes()
    if (!snap || snap.confidence === "LOW") return null
    return side === "UP" ? snap.up.price : snap.down.price
  }

  /**
   * ROLLOVER BARRIER exit check — verifies the full pipeline for the NEW slot
   * end-to-end. All four conditions must hold simultaneously:
   *   1. market discovered for the current slot
   *   2. token ids verified in the price feed (generation advanced to them)
   *   3. websocket subscribed to the new tokens
   *   4. first validated quote pair of the new generation received
   * Only then does the engine return to LIVE and resume decisions.
   */
  private tryExitRollover() {
    const now = Date.now()
    const diag = this.clobPriceFeed.diagnostics()
    // (1) + (2): market discovered AND its tokens are what the feed tracks.
    const m = this.market
    const marketReady =
      m !== null && m.slotEndMs === this.slotEndMs && diag.upTokenId === m.upTokenId && diag.downTokenId === m.downTokenId
    // (3): WS subscribed to the new tokens (subscribe sent on current socket).
    const ws = this.clobPriceFeed.wsDiagnostics()
    const wsReady = ws.connected && ws.subscribeSentAtMs > 0
    // (4): a validated snapshot of the CURRENT generation exists.
    const snap = this.clobPriceFeed.validatedQuotes()
    const quotesReady = snap !== null

    if (marketReady && wsReady && quotesReady) {
      this.rolloverState = "LIVE"
      logEvent(
        "info",
        `Rollover barrier CLEARED in ${((now - this.rolloverStartedAtMs) / 1000).toFixed(1)}s — market ${m!.slug}, generation ${snap!.generation}, confidence ${snap!.confidence} — engine LIVE`,
      )
      return
    }
    // Throttled progress log so a stuck barrier is diagnosable, not silent.
    if (now - this.lastRolloverLogMs > 10_000) {
      this.lastRolloverLogMs = now
      logEvent(
        "info",
        `Rollover barrier HOLDING (${((now - this.rolloverStartedAtMs) / 1000).toFixed(0)}s): market ${marketReady ? "ready" : "pending"} | ws ${wsReady ? "subscribed" : "pending"} | validated quotes ${quotesReady ? "ready" : `pending (${diag.validationFailReason || "waiting"})`}`,
      )
    }
  }

  /**
   * ONE AUTHORITATIVE BANKROLL (Phase 5). The kv-persisted, ledger-driven
   * Bankroll (debit at fill, credit at settlement → net move = PnL) is the
   * single source of truth for the pool in BOTH modes.
   *
   * ROOT-CAUSE FIX: this method used to OVERWRITE `bankroll.balance` from the
   * executor wallet on every rollover. The paper wallet is an IN-MEMORY
   * mirror that resets on restart — after a restart it could receive a
   * settlement credit (e.g. +$7.00 payout) without the matching fill debit,
   * and the overwrite then stomped the true ledger balance with that number:
   * the displayed bankroll jumped by the PAYOUT instead of the PnL (+$0.07).
   *
   * New contract:
   * - PAPER_V1: NEVER writes the bankroll. Re-seeds the wallet mirror FROM
   *   the bankroll (authority → mirror), then reports drift read-only.
   * - LIVE_V2: on-chain balance is exchange truth, but it is applied as an
   *   audited RECONCILIATION — dust-aware, drift-logged with a permanent
   *   order_log row when |onchain − ledger| > $0.05 — never a silent stomp.
   * - First read still seeds the starting baseline in both modes.
   */
  private async syncLiveBalance(): Promise<void> {
    if (!this.executor?.getAvailableBalanceUsd) return
    const usd = await this.executor.getAvailableBalanceUsd()
    if (usd === null) return
    const pool = this.bankroll.balance + this.bankroll.dustReserve

    if (this.bankroll.startingBalance === 0) {
      this.bankroll.reset(usd) // seed starting baseline + balance (both modes)
      if (this.mode === "PAPER_V1") this.executor.setWalletUsd?.(usd)
      logEvent("info", `[${this.mode}] Bankroll baseline seeded from wallet: $${usd.toFixed(2)}`)
      return
    }

    if (this.mode === "PAPER_V1") {
      // Authority → mirror: push the ledger pool INTO the sim wallet.
      this.executor.setWalletUsd?.(pool)
      const drift = usd - pool
      if (Math.abs(drift) > 0.05) {
        logEvent(
          "warn",
          `[PAPER_V1] wallet mirror drifted $${drift.toFixed(2)} from ledger bankroll (wallet $${usd.toFixed(2)} vs pool $${pool.toFixed(2)}) — mirror re-seeded; bankroll NOT modified`,
        )
      }
      return
    }

    // LIVE_V2: audited reconciliation. On-chain is truth, but any material
    // divergence from the ledger is a red flag (missed fill debit, missed
    // settlement credit, external deposit/withdrawal) — record it permanently.
    //
    // BUG #7 (bankroll reconciliation race): NEVER overwrite the ledger while
    // a settlement or fill is in flight. `rolloverSlot` dispatches
    // `settleOfficial` asynchronously and this method runs on the SAME
    // rollover; if on-chain USDC had already reflected a redeemed payout, the
    // overwrite would snap the ledger up by +payout and the subsequent
    // `bankroll.settle(payout)` would then credit the payout a SECOND time.
    // The per-settlement invariant check reads `openingTotal` AFTER the
    // stomp, so it cannot detect the drift. Defer reconciliation until the
    // next rollover — the on-chain number isn't going anywhere.
    const pendingSettles = this.standingOrders?.pendingSettlementCount() ?? 0
    if (pendingSettles > 0 || this.pendingResolutions > 0 || this.openOrder !== null) {
      logEvent(
        "info",
        `[LIVE_V2] balance reconciliation DEFERRED: ${pendingSettles} pending settlement(s), ${this.pendingResolutions} pending resolution(s), openOrder=${this.openOrder !== null ? "yes" : "no"} — will retry on next rollover (on-chain $${usd.toFixed(2)} vs ledger pool $${pool.toFixed(2)})`,
      )
      return
    }
    const drift = usd - pool
    if (Math.abs(drift) > 0.05) {
      logEvent(
        "warn",
        `[LIVE_V2] on-chain balance $${usd.toFixed(2)} diverges from ledger bankroll $${pool.toFixed(2)} (drift $${drift.toFixed(2)}) — reconciling to on-chain with audit trail`,
      )
      insertOrderLog({
        mode: this.mode,
        event: "ERROR",
        marketId: this.market?.conditionId ?? "n/a",
        detail: `BANKROLL_RECONCILED to on-chain: ledger pool $${pool.toFixed(4)} → on-chain $${usd.toFixed(4)} (drift $${drift.toFixed(4)}); possible missed debit/credit or external transfer`,
      })
    }
    // Dust-aware mapping: the on-chain number contains the dust reserve.
    this.bankroll.balance = Math.max(0, Math.round((usd - this.bankroll.dustReserve) * 10000) / 10000)
    logEvent("info", `[LIVE_V2] Live balance reconciled: $${usd.toFixed(2)} on-chain (pool $${(this.bankroll.balance + this.bankroll.dustReserve).toFixed(2)})`)
  }


  /**
   * Condition IDs of the markets the engine is ACTIVELY monitoring right now.
   * Used to scope the authenticated User-channel WebSocket subscription so it
   * only receives order/trade events for relevant markets. The 5-minute BTC
   * pipeline monitors a single market per slot, but this returns an array so
   * multiple concurrently-active markets are supported without changes.
   */
  private activeConditionIds(): string[] {
    const ids: string[] = []
    if (this.market?.conditionId) ids.push(this.market.conditionId)
    return ids
  }

  // ---------- market discovery ----------

  /**
   * Fire-and-forget Gamma resolution for the current slot plus a
   * prefetch of the next one, so real token ids are in cache well
   * before the T-20s firing window opens. Never blocks the loop.
   */
  private armMarket(slotEndMs: number) {
    // If the next slot's market was already prefetched (the normal case, since
    // we prefetch a slot ahead), install its tokens SYNCHRONOUSLY so the price
    // feed never has a null-quote gap at the rollover boundary. Only when there
    // is no cached market do we clear (so we never show/trade the old slot).
    const cached = this.discovery.peek(slotEndMs)
    if (cached && cached.slotEndMs === slotEndMs) {
      this.market = cached
      this.clobPriceFeed.setTokenIds(cached.upTokenId, cached.downTokenId)
    } else {
      this.clobPriceFeed.clearTokenIds()
    }
    void this.discovery.resolve(slotEndMs).then((m) => {
      if (m && slotEndMs === this.slotEndMs) {
        this.market = m
        // Push the new token IDs into the price feed so it starts
        // polling live CLOB prices for the current slot.
        this.clobPriceFeed.setTokenIds(m.upTokenId, m.downTokenId)
        notify("market", "NEW MARKET DETECTED", `${m.slug}\nSettles: ${new Date(slotEndMs).toISOString().slice(11, 19)} UTC`)
      }
    }).catch((e) => {
      // Never let a discovery failure become an unhandled rejection — the
      // engine keeps ticking on the cached market and discovery retries.
      logEvent("warn", `market resolve failed for slot ${slotEndMs}: ${e instanceof Error ? e.message : String(e)}`, "engine")
    })
    void this.discovery.resolve(slotEndMs + SLOT_MS).catch(() => {
      /* prefetch is best-effort; the on-slot resolve above retries */
    })
  }

  /** Real Gamma-discovered ids in BOTH modes — the paper executor's fill
   *  engine reads the live CLOB, so synthetic ids would break it too. */
  private orderIds(side: TradeSide): { marketId: string; tokenId: string } | null {
    const m = this.market
    if (m && m.slotEndMs === this.slotEndMs) {
      return { marketId: m.slug, tokenId: side === "UP" ? m.upTokenId : m.downTokenId }
    }
    return null // never sign or simulate against synthetic ids
  }

  // ---------- market model helpers ----------

  /**
   * BTC reference staleness guard: a Chainlink tick older than this must
   * never drive the (registry-strategy) drift guard — a frozen tape during
   * an RPC outage would otherwise look like directional certainty. Note the
   * Standing Limit Order does NOT use this: it trades solely on live CLOB
   * prices and holds (NO_DATA) whenever those are unavailable.
   */
  private static readonly SPOT_STALE_MS = 10_000

  private freshSpot(): number | null {
    const tick = this.spotFeed.latest
    if (!tick) return null
    if (Date.now() - tick.tsMs > Edge5Engine.SPOT_STALE_MS) return null
    return tick.price
  }

  private fairFor(side: TradeSide): number {
    const spot = this.spotFeed.latest?.price ?? 0
    const strike = this.strike ?? spot
    const prices = tokenPrices(spot, strike, tMinusMs())
    return side === "UP" ? prices.up : prices.down
  }

  // ---------- main 50ms decision loop ----------

  private async tick() {
    if (!this.running || !this.executor) return
    // Deadlock guard: if a previous tick is still in-flight after 5s,
    // reset the flag so the engine does not permanently stall.
    if (this.busy) {
      if (Date.now() - this.lastTickStartMs > 5_000) {
        this.busy = false
        logEvent("warn", "tick busy watchdog fired — resetting busy flag to prevent engine deadlock")
      }
      return
    }
    const traceId = `tick-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const trace = startTrace(traceId)
    this.lastTickStartMs = Date.now()
    this.busy = true
    try {
      const slotEnd = currentSlotEndMs()

      // Slot rollover: settle the expired candle, arm the next one, and enter
      // the ROLLING_OVER barrier — no decision runs until the new market's
      // full pipeline (discovery → tokens → WS → first validated quote pair)
      // is proven end-to-end by tryExitRollover().
      if (slotEnd !== this.slotEndMs) {
        this.rolloverState = "ROLLING_OVER"
        this.rolloverStartedAtMs = Date.now()
        await this.settleSlot()
        this.slotEndMs = slotEnd
        this.strike = null
        this.market = this.discovery.peek(slotEnd)
        this.armMarket(slotEnd)
        // LIVE_V2: purge any stray resting orders left on the old market book,
        // then refresh the on-chain balance for the new slot. Both are
        // fire-and-forget so the 50ms loop never stalls on network I/O.
        if (this.executor) {
          // cancelAll purges EVERY order on the account, including a fresh
          // Standing Limit Order placed at the boundary of the new window.
          // Only issue it when a registry strategy is actually active (i.e.
          // this engine could have left a stray order behind); when only the
          // SLO runs, it manages its own targeted cancels and cancelAll is
          // pure race-risk with zero benefit.
          if (this.executor.cancelAllOrders && this.cfg.activeStrategy !== null) {
            void this.executor.cancelAllOrders().catch((e) =>
              logEvent("warn", `[${this.mode}] rollover cancelAll failed: ${(e as Error).message}`),
            )
          }
          void this.syncLiveBalance()
          // New 5-minute window: re-sync the read-only account mirror so the
          // dashboard reflects the live account at the slot boundary.
          void this.accountSync?.refresh("rollover")
          // Re-point the User-channel subscription at the newly-armed market so
          // we only ever receive events for the markets we're monitoring.
          getOrderEventListener().setMarkets(this.activeConditionIds())
        }
      }

      recordPoint(traceId, "trigger-detect")

      // ROLLOVER BARRIER: attempt to re-enter LIVE; while still ROLLING_OVER,
      // skip every decision path (strategy + fill polling) for this tick.
      if (this.rolloverState === "ROLLING_OVER") {
        this.tryExitRollover()
        if (this.rolloverState === "ROLLING_OVER") {
          recordPoint(traceId, "tick-complete")
          completeTrace(traceId)
          return
        }
      }

      // Capture the strike from the first FRESH spot tick of the candle;
      // a stale tick from a dropped WS must never define the strike.
      if (this.strike === null) {
        const fresh = this.freshSpot()
        if (fresh !== null) this.strike = fresh
      }

      const phase = phaseFor(tMinusMs(), this.cfg)
      recordPoint(traceId, "phase-detect")
      // Current token prices — used by both the strategy decision and
      // the standing limit order trigger check below.
      const spotForPrices = this.spotFeed.latest
      const prices =
        spotForPrices && this.strike !== null
          ? tokenPrices(spotForPrices.price, this.strike, tMinusMs())
          : spotForPrices
            ? tokenPrices(spotForPrices.price, spotForPrices.price, tMinusMs())
            : { up: 0.5, down: 0.5 }
      
      // Only run strategy if one is actively selected (not null).
      // Standing Limit Order executes independently below, regardless of strategy status.
      if (this.cfg.activeStrategy !== null) {
        const strategy = getStrategy(this.cfg.activeStrategy)
        recordPoint(traceId, "risk-check")
        const decision = strategy.decide(
          {
            phase,
            spot: this.freshSpot(),
            strike: this.strike,
            cfg: this.cfg,
            fairFor: (s) => this.fairFor(s),
            openOrder: this.openOrder ? { side: this.openOrder.side, price: this.openOrder.price, placedAtMs: this.openOrder.placedAtMs } : null,
            hasPosition: this.position !== null,
          },
          this.cfg.strategyParams[this.cfg.activeStrategy] ?? {},
        )

        if (decision.reason !== this.lastReason && decision.action !== "HOLD") {
          this.lastReason = decision.reason
        }

        switch (decision.action) {
          case "CANCEL": {
            recordPoint(traceId, "order-submit-cancel")
            const order = this.openOrder
            this.openOrder = null
            if (order) {
              // The in-memory reference is already cleared, so a cancel failure
              // must not throw out of the tick — it would leave a live order
              // with no owner and no log. Record the orphan risk explicitly.
              try {
                await this.executor.cancelOrder(order)
              } catch (e) {
                logEvent(
                  "error",
                  `CANCEL failed for ${order.exchangeOrderId ?? order.clientOrderId}: ${(e as Error).message} — order may still rest (rollover cancelAll is the backstop)`,
                )
              }
              logEvent("warn", decision.reason)
              // Fire-and-forget audit logging
              void insertOrderLog({
                mode: this.mode,
                event: "CANCELLED",
                marketId: order.marketId,
                tokenId: order.tokenId,
                exchangeOrderId: order.exchangeOrderId,
                side: order.side,
                price: order.price,
                shares: order.shares,
                phase: order.phase,
                detail: decision.reason,
              })
            }
            break
          }
          case "QUOTE": {
            if (decision.side && decision.price !== null) {
              recordPoint(traceId, "order-submit-quote")
              await this.quote(decision.side, decision.price, phase, decision.tif ?? this.cfg.tif, decision.expireAtMs)
            }
            break
          }
          case "REPRICE": {
            if (this.openOrder && decision.side && decision.price !== null) {
              recordPoint(traceId, "order-submit-reprice")
              await this.reprice(decision.side, decision.price, phase, decision.reason, decision.tif ?? this.cfg.tif, decision.expireAtMs)
            }
            break
          }
        }
        recordPoint(traceId, "order-executed")
      }

      // Poll resting order for a maker fill.
      if (this.openOrder && !this.position) {
        recordPoint(traceId, "fill-check-start")
        const fill = await this.executor.checkFill(this.openOrder)
        recordPoint(traceId, "fill-check-end")
        if (fill) this.onFill(fill.order, fill.filledPrice, traceId)
      }

      // NOTE: The Standing Limit Order is intentionally NOT handled here.
      // It runs on its own independent loop (StandingOrderManager),
      // decoupled from this tick loop and the Time Window / phase machine.
      recordPoint(traceId, "tick-complete")
      completeTrace(traceId)
    } catch (e) {
      // Throttle identical repeating errors: the 50ms loop would
      // otherwise flood the event log 20x/second during an outage.
      const msg = e instanceof Error ? e.message : String(e)
      const now = Date.now()
      if (msg !== this.lastTickErrorMsg || now - this.lastTickErrorAtMs > 10_000) {
        this.lastTickErrorMsg = msg
        this.lastTickErrorAtMs = now
        logEvent("error", `tick error: ${msg}`)
        insertOrderLog({
          mode: this.mode,
          event: "ERROR",
          marketId: this.market?.slug ?? marketIdForSlot(this.slotEndMs),
          detail: msg.slice(0, 300),
        })
      }
    } finally {
      this.busy = false
    }
  }

  private async quote(side: TradeSide, price: number, phase: EnginePhase, tif: TIF, expireAtMs: number | null) {
    if (!this.executor) return
    let sizing = this.bankroll.size(price, this.cfg.minShares)
    if (!sizing) {
      // Dynamic 5-share protocol guard: auto-scale paper capital upward.
      const pool = this.bankroll.balance + this.bankroll.dustReserve
      const validation = validateOrderSize(pool, price, this.cfg.minShares)
      if (this.mode === "PAPER_V1" && validation.scaled && pool > 0) {
        logEvent("warn", `${validation.reason} (auto-scaling paper pool)`)
        this.bankroll.reset(validation.requiredCapital)
        sizing = this.bankroll.size(price, this.cfg.minShares)
      }
      if (!sizing) {
        logEvent("warn", `Skipping quote: capital pool cannot clear the ${this.cfg.minShares}-share minimum @ $${price.toFixed(2)}`)
        return
      }
    }
    const ids = this.orderIds(side)
    if (!ids) {
      logEvent("warn", "Skipping quote: live market ids not yet resolved from Gamma")
      return
    }
    // MANDATORY RISK GATE — kill switch, daily loss breaker, caps, sanity.
    const verdict = this.risk.checkOrder({ price, shares: sizing.shares, slotEndMs: this.slotEndMs })
    if (!verdict.ok) {
      logEvent("warn", `Quote VETOED by risk gate: ${verdict.reason}`)
      return
    }
    this.openOrder = await this.executor.placeOrder({
      marketId: ids.marketId,
      tokenId: ids.tokenId,
      side,
      price,
      shares: sizing.shares,
      phase,
      tif,
      expireAtMs,
    })
    insertOrderLog({
      mode: this.mode,
      event: "SUBMITTED",
      marketId: ids.marketId,
      tokenId: ids.tokenId,
      exchangeOrderId: this.openOrder.exchangeOrderId,
      side,
      price,
      shares: sizing.shares,
      phase,
    })
  }

  private async reprice(side: TradeSide, price: number, phase: EnginePhase, reason: string, tif: TIF, expireAtMs: number | null) {
    if (!this.executor || !this.openOrder) return
    const sizing = this.bankroll.size(price, this.cfg.minShares)
    if (!sizing) return
    const ids = this.orderIds(side)
    if (!ids) return
    // RISK GATE on the replacement leg. A kill-switch veto here also cancels
    // the existing resting order — an engaged kill switch means FLAT, not
    // "keep the old quote resting".
    const verdict = this.risk.checkOrder({ price, shares: sizing.shares, slotEndMs: this.slotEndMs })
    if (!verdict.ok) {
      logEvent("warn", `Reprice VETOED by risk gate: ${verdict.reason}`)
      if (this.risk.killSwitch.engaged) {
        const stale = this.openOrder
        this.openOrder = null
        try {
          await this.executor.cancelOrder(stale)
          logEvent("warn", "Kill switch: resting order cancelled — engine is flat")
        } catch (e) {
          logEvent("error", `Kill switch cancel failed: ${(e as Error).message} — order may still rest`)
        }
      }
      return
    }
    const { order, latencyMs } = await this.executor.cancelReplace(this.openOrder, {
      marketId: ids.marketId,
      tokenId: ids.tokenId,
      side,
      price,
      shares: sizing.shares,
      phase,
      tif,
      expireAtMs,
    })
    this.openOrder = order
    this.lastCancelReplaceMs = latencyMs
    insertOrderLog({
      mode: this.mode,
      event: "REPLACED",
      marketId: ids.marketId,
      tokenId: ids.tokenId,
      exchangeOrderId: order.exchangeOrderId,
      side,
      price,
      shares: sizing.shares,
      phase,
      detail: `${latencyMs}ms — ${reason}`,
    })
    const latency = classifyCancelReplace(latencyMs, this.cfg.cancelReplaceBudgetMs)
    logEvent(latency.withinBudget ? "info" : "warn", `${latency.reason} — ${reason}`)
  }

  private onFill(order: OpenOrder, filledPrice: number, traceId?: string) {
    if (traceId) recordPoint(traceId, "onFill-start")
    const sizing = this.bankroll.size(filledPrice, this.cfg.minShares)
    const shares = order.shares
    const cost = Math.round(shares * filledPrice * 10000) / 10000
    const pool = this.bankroll.balance + this.bankroll.dustReserve
    const dust = Math.round((pool - cost) * 10000) / 10000
    void sizing
    this.position = {
      side: order.side,
      price: filledPrice,
      shares,
      cost,
      dust: Math.max(dust, 0),
      marketId: order.marketId,
      slotEndMs: this.slotEndMs,
    }
    this.bankroll.commitFill({ shares, cost, dust: Math.max(dust, 0), capitalPool: pool })
    this.openOrder = null
    logEvent("trade", `FILLED ${order.side} ${shares} shares @ $${filledPrice.toFixed(2)} (dust swept $${Math.max(dust, 0).toFixed(4)})`)
    // Fire-and-forget audit logging — never blocks execution
    void insertOrderLog({
      mode: this.mode,
      event: "FILLED",
      marketId: order.marketId,
      tokenId: order.tokenId,
      exchangeOrderId: order.exchangeOrderId,
      side: order.side,
      price: filledPrice,
      shares,
      phase: order.phase,
      detail: `cost $${cost.toFixed(4)}, dust $${Math.max(dust, 0).toFixed(4)}`,
    })
    if (traceId) recordPoint(traceId, "onFill-complete")
  }

  private async settleSlot() {
    const pos = this.position
    this.position = null
    const order = this.openOrder
    this.openOrder = null

    // Open-exposure orphan cleaner: a leg filled (position held) while a
    // second leg was still resting unhedged at slot close. Flatten it with
    // an immediate market-priced FOK counter before the candle resolves.
    if (order && pos && detectOrphan("FILLED", "PENDING") && this.executor) {
      const counter = buildOrphanCounter(pos.side, order.shares, this.fairFor(pos.side === "UP" ? "DOWN" : "UP"))
      logEvent("warn", counter.reason)
      await this.executor.cancelOrder(order).catch(() => {})
    } else if (order && this.executor) {
      await this.executor.cancelOrder(order).catch(() => {})
    }
    if (!pos) return

    // Official Polymarket resolution is the single source of truth in BOTH
    // paper and live modes. Capture the strict spot fallback synchronously here
    // (the strike is cleared right after settleSlot returns); settleOfficial
    // runs in the background so the 50ms loop is never stalled.
    const fallback = this.computeSpotFallback()
    void this.settleOfficial(pos, fallback)
  }

  /**
   * Resolve and settle a position against the OFFICIAL Polymarket outcome
   * (Chainlink-resolved), in BOTH paper and live modes. Never fabricates a
   * win/loss: prefers the official resolution, then a STRICT spot fallback,
   * then SCRATCH (cost refunded, zero PnL) when neither is reliable.
   */
  private async settleOfficial(pos: FilledPosition, fallbackWinner: TradeSide | null) {
    this.pendingResolutions++
    try {
      let winner: TradeSide | null = null
      for (let attempt = 0; attempt < RESOLUTION_ATTEMPTS && winner === null; attempt++) {
        winner = await this.discovery.fetchResolution(pos.slotEndMs)
        if (winner === null) await new Promise((r) => setTimeout(r, RESOLUTION_POLL_MS))
      }
      if (winner !== null) {
        this.recordSettlement(pos, winner, "official")
      } else if (fallbackWinner !== null) {
        logEvent(
          "warn",
          `[settlement] official resolution unavailable for ${pos.marketId} after ${RESOLUTION_ATTEMPTS} attempts — using strict spot fallback winner=${fallbackWinner}`,
        )
        this.recordSettlement(pos, fallbackWinner, "spot-fallback")
      } else {
        logEvent(
          "error",
          `[settlement] CRITICAL: no official resolution and no reliable spot fallback for ${pos.marketId} — settling SCRATCH (cost refunded) to avoid a fabricated win/loss`,
        )
        this.recordSettlement(pos, null, "scratch")
      }
    } catch (e) {
      // Never fabricate a loss on error: settle SCRATCH so the trade is not
      // recorded against the account on unverified data.
      logEvent(
        "error",
        `[settlement] resolution poll crashed for ${pos.marketId}: ${e instanceof Error ? e.message : String(e)} �� settling SCRATCH`,
      )
      this.recordSettlement(pos, null, "scratch")
    } finally {
      this.pendingResolutions--
    }
  }

  /**
   * Strict, fail-safe spot winner for use ONLY when the official resolution is
   * unavailable. Returns null (→ SCRATCH) unless there is a FRESH Chainlink
   * tick, a captured strike, and a decisive move — never guesses a near-the-
   * money candle or settles off a stale/zero price.
   */
  private computeSpotFallback(): TradeSide | null {
    const price = this.freshSpot()
    if (price === null || !Number.isFinite(price) || price <= 0) return null
    if (this.strike === null) return null
    const margin = price - this.strike
    if (Math.abs(margin) < FALLBACK_MIN_MARGIN_USD) return null
    return margin >= 0 ? "UP" : "DOWN"
  }

  private recordSettlement(pos: FilledPosition, winner: TradeSide | null, source: string) {
    const isScratch = winner === null
    const won = !isScratch && pos.side === winner
    const result: "WIN" | "LOSS" | "SCRATCH" = isScratch ? "SCRATCH" : won ? "WIN" : "LOSS"
    // Pool was debited `cost` on fill. WIN pays $1/share; LOSS pays 0; SCRATCH
    // refunds the cost so the slot nets exactly zero.
    const payout = isScratch ? pos.cost : won ? pos.shares : 0
    const pnl = isScratch ? 0 : Math.round((payout - pos.cost) * 10000) / 10000

    this.bankroll.settle(payout)
    const balanceAfter = this.bankroll.balance + this.bankroll.dustReserve

    // PAPER_V1: mirror the payout into the simulated wallet (debited on fill).
    // Without this credit the sim wallet drains monotonically over a long
    // session until orders are rejected for "not enough balance".
    if (payout > 0) {
      try {
        this.executor?.creditSettlement?.(payout)
      } catch {
        /* wallet mirror must never crash settlement */
      }
    }

    insertTrade({
      marketId: pos.marketId,
      slotEndMs: pos.slotEndMs,
      side: pos.side,
      price: pos.price,
      shares: pos.shares,
      cost: pos.cost,
      result,
      pnl,
      balanceAfter,
      dustSaved: pos.dust,
      mode: this.mode,
      // Permanent audit record: why the trade settled the way it did and the
      // exact PnL math — queryable forever from the ledger.
      explanation: JSON.stringify({
        entry: `strategy engine: ${pos.side} filled at $${pos.price.toFixed(4)} (${pos.shares} shares, cost $${pos.cost.toFixed(4)})`,
        settlement: isScratch
          ? `SCRATCH — no reliable market resolution (source: ${source}); entry cost refunded so the slot nets exactly zero`
          : won
            ? `WIN — bet ${pos.side}, official winner ${winner} (source: ${source}); each share paid out $1.00`
            : `LOSS — bet ${pos.side}, official winner ${winner} (source: ${source}); shares expired worthless`,
        resolvedWinner: winner,
        resolutionSource: source,
        pnlCalc: isScratch
          ? `cost $${pos.cost.toFixed(4)} refunded; realized PnL $0.0000`
          : `payout $${payout.toFixed(4)} − cost $${pos.cost.toFixed(4)} = ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`,
      }),
    })

    // Immutable winning token id (best-effort from the cached market record).
    const mkt = this.discovery.peek(pos.slotEndMs)
    const winningTokenId = isScratch || !mkt ? null : winner === "UP" ? mkt.upTokenId : mkt.downTokenId

    // Structured per-trade settlement audit line — the single place to debug a
    // win/loss classification. Contains every input to the decision.
    logEvent(
      "trade",
      `[settlement] ${JSON.stringify({
        marketId: pos.marketId,
        slotEndMs: pos.slotEndMs,
        betSide: pos.side,
        entryPrice: pos.price,
        shares: pos.shares,
        cost: Math.round(pos.cost * 10000) / 10000,
        resolvedWinner: winner,
        winningTokenId,
        result,
        source,
        settledAtMs: Date.now(),
        pnl,
        balanceAfter: Math.round(balanceAfter * 10000) / 10000,
        reason: isScratch
          ? "no reliable resolution — cost refunded, zero PnL"
          : won
            ? `bet ${pos.side} == winner ${winner}`
            : `bet ${pos.side} != winner ${winner}`,
      })}`,
    )
    logEvent(
      "trade",
      `SETTLED ${pos.marketId}: ${pos.side} ${result} — PnL ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}, bankroll $${balanceAfter.toFixed(2)} [${source}]`,
    )
    insertOrderLog({
      mode: this.mode,
      event: "SETTLED",
      marketId: pos.marketId,
      side: pos.side,
      price: pos.price,
      shares: pos.shares,
      detail: `${result} winner=${winner ?? "none"} src=${source} pnl=$${pnl.toFixed(4)} balance=$${balanceAfter.toFixed(4)}`,
    })

    // Telegram cards represent realized outcomes; a SCRATCH (no PnL) is not
    // broadcast as a win/loss.
    if (!isScratch) {
      getTelegram(this)?.broadcastSettlement({
        marketId: pos.marketId,
        side: pos.side,
        filledPrice: pos.price,
        result: won ? "WIN" : "LOSS",
        pnl,
        bankroll: balanceAfter,
        dust: this.bankroll.dustReserve,
      })
    } else {
      // SCRATCH goes through the category-gated notifier instead (the
      // interactive bot's PnL card is reserved for realized outcomes).
      notify("trades", "TRADE SCRATCH", `Market: ${pos.marketId}\nEntry cost refunded — no realized PnL\nBankroll: $${balanceAfter.toFixed(2)}`)
    }
  }

  // ---------- dashboard snapshot ----------

  snapshot(): EngineSnapshot {
    const spot = this.spotFeed.latest
    const strike = this.strike
    const tm = tMinusMs()

    // Contract prices come EXCLUSIVELY from the live Polymarket CLOB, read
    // through ONE atomic validated snapshot (generation + identity + freshness
    // gated) — the same choke point the engines trade through. When no valid
    // snapshot exists the prices are null and the UI shows NO DATA. The
    // canonical UP/DOWN value is the best ask (BUY) — the exact number on
    // Polymarket's buy buttons.
    const feedSnap = this.clobPriceFeed.validatedQuotes()
    const clobFresh = feedSnap !== null
    let upTokenPrice: number | null = null
    let downTokenPrice: number | null = null
    let clobQuote: EngineSnapshot["clobQuote"] = null
    if (feedSnap) {
      const { up, down } = feedSnap
      upTokenPrice = up.price
      downTokenPrice = down.price
      clobQuote = {
        up: { ask: up.ask, bid: up.bid, mid: up.mid, last: up.last, lastSide: up.lastSide },
        down: { ask: down.ask, bid: down.bid, mid: down.mid, last: down.last, lastSide: down.lastSide },
      }
    }

    const stats = tradeStats(this.mode)
    const phase: EnginePhase = this.running ? phaseFor(tm, this.cfg) : "OFFLINE"
    const direction =
      spot && strike !== null
        ? evaluateOracleGuard(spot.price, strike, this.cfg.driftPaddingUsd, spot.tsMs).side
        : null

    return {
      running: this.running,
      mode: this.mode,
      phase,
      slotEndMs: currentSlotEndMs(),
      tMinusMs: tm,
      clockOffsetMs: clockOffsetMs(),
      clockSynced: clockSynced(),
      spot,
      strike,
      direction,
      driftGuardClear: direction !== null,
      upTokenPrice,
      downTokenPrice,
      clobQuote,
      clobBook: this.clobPriceFeed.bookDepth,
      clobPriceChange: this.clobPriceFeed.priceChange(),
      clobPricesFresh: clobFresh,
      balance: this.bankroll.balance,
      dustReserve: this.bankroll.dustReserve,
      startingBalance: this.bankroll.startingBalance,
      totalPnl: stats.totalPnl,
      wins: stats.wins,
      losses: stats.losses,
      openOrder: this.openOrder,
      lastCancelReplaceMs: this.lastCancelReplaceMs,
      activeStrategy: this.cfg.activeStrategy,
      config: this.cfg,
      events: recentEvents(),
      telegramConnected: getTelegram(this)?.connected ?? false,
      liveKeysLoaded: Boolean(env.POLY_PRIVATE_KEY && env.POLY_API_KEY),
      liveMarket:
        this.market && this.market.slotEndMs === this.slotEndMs
          ? {
              slug: this.market.slug,
              question: this.market.question,
              conditionId: this.market.conditionId,
              // Always coerce to boolean — Gamma can return null for these
              // fields on freshly-listed markets that haven't opened yet.
              active: Boolean(this.market.active),
              closed: Boolean(this.market.closed),
              upTokenId: this.market.upTokenId,
              downTokenId: this.market.downTokenId,
              volumeUsd: this.market.volumeUsd,
              liquidityUsd: this.market.liquidityUsd,
              endDateIso: this.market.endDateIso,
            }
          : null,
      marketDiscovery: this.market ? "ready" : "waiting",
      awaitingResolution: this.pendingResolutions > 0,
      standingLimitOrder: this.standingOrders.snapshot(),
      risk: this.risk.snapshot(),
      reconcile: this.reconciler.latest,
      watchdog: this.watchdog.snapshot(),
      feedStats: feedStats(this.mode),
      lastAccountingAudit: getLastAccountingAudit(),
      clobDiagnostics: this.clobPriceFeed.diagnostics(),
      rolloverState: this.running ? this.rolloverState : "LIVE",
      feedSnapshotInfo: feedSnap
        ? {
            generation: feedSnap.generation,
            sequence: feedSnap.sequence,
            timestampMs: feedSnap.timestampMs,
            upAgeMs: feedSnap.upAgeMs,
            downAgeMs: feedSnap.downAgeMs,
            wsFreshMs: feedSnap.wsFreshMs,
            restFreshMs: feedSnap.restFreshMs,
            confidence: feedSnap.confidence,
            upSource: feedSnap.up.source,
            downSource: feedSnap.down.source,
          }
        : null,
      liveAccount: this.accountSync?.get() ?? null,
    }
  }
}

// ---------- HMR-safe process singleton ----------

// Keep a VERSION token that matches the current module build. When HMR hot-
// patches this file the module re-executes, bumping the in-memory version
// string. If the cached singleton was built with an older version its class
// instances (ClobPriceFeed, StandingOrderManager, …) won't have the new
// methods, so we discard and rebuild.
const ENGINE_VERSION = "2026-07-14-feed-integrity-v20"

// V2 singleton lives under its OWN global key so it runs fully independently
// from the V1 (paper) engine in the same persistent Node process.
const globalRef = globalThis as unknown as {
  __botEngineV2?: Edge5Engine
  __botEngineV2Version?: string
  __botProcessGuards?: boolean
}

/**
 * Process-level crash guards. Without these, ONE stray promise rejection in a
 * timer/WS callback hard-crashes the entire Node process (Node's default).
 * PM2 would restart + auto-resume, but a repeating rejection becomes a crash
 * loop that churns sessions and WS connections. Policy:
 *  • unhandledRejection → log loudly, keep the process alive (the watchdog
 *    and reconciler recover subsystem state on their next cycle).
 *  • uncaughtException  → log, then exit(1) so PM2 restarts from a clean
 *    slate — a sync throw means memory state can no longer be trusted.
 */
function installProcessGuards(): void {
  if (globalRef.__botProcessGuards) return
  globalRef.__botProcessGuards = true
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    try { logEvent("error", `[PROCESS] Unhandled promise rejection (kept alive): ${msg.slice(0, 400)}`) } catch { /* ignore */ }
  })
  process.on("uncaughtException", (err) => {
    try { logEvent("error", `[PROCESS] Uncaught exception — exiting for clean PM2 restart: ${(err.stack ?? err.message).slice(0, 400)}`) } catch { /* ignore */ }
    process.exit(1)
  })
}

export function getEngine(): Edge5Engine {
  installProcessGuards()
  if (!globalRef.__botEngineV2 || globalRef.__botEngineV2Version !== ENGINE_VERSION) {
    // If there was an engine from a previous version, fully DISPOSE it (main
    // loop + SLO loop + price-feed timer) so no orphaned interval leaks and
    // races the new instance, then discard the stale reference.
    if (globalRef.__botEngineV2 && globalRef.__botEngineV2Version !== ENGINE_VERSION) {
      try { globalRef.__botEngineV2.dispose() } catch { /* ignore */ }
    }
    globalRef.__botEngineV2 = new Edge5Engine()
    globalRef.__botEngineV2Version = ENGINE_VERSION
  }
  return globalRef.__botEngineV2
}
