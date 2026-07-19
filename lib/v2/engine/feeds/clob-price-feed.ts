import { env } from "../config"
import { logEvent } from "../events"
import { ClobWsClient, type WsBestAsk } from "./clob-ws-client"

// ------------------------------------------------------------
// ClobPriceFeed — the SINGLE SOURCE OF TRUTH for Polymarket
// contract prices. Polls clob.polymarket.com directly for the Up
// and Down token IDs of the current 5-minute market and exposes the
// real order-book values:
//
//   • best ask  (GET /price?token_id&side=BUY)   — price to BUY the contract
//   • best bid  (GET /price?token_id&side=SELL)  — price to SELL the contract
//   • midpoint  (GET /midpoint?token_id)          — book midpoint
//   • last      (GET /last-trade-price?token_id)  — last traded price
//
// The CANONICAL price (used for majority side, trigger detection, and
// paper fills) is the BEST ASK — the exact number a taker pays and the
// value shown on the Polymarket "Up 85¢ / Down 14¢" buy buttons.
//
// GENERATION MODEL (market-data integrity):
//   Every change of token IDs increments a monotonic GENERATION counter.
//   All quote writes capture the generation at request start and are
//   DISCARDED at write time if the generation has moved on — an in-flight
//   REST poll or late WS frame from a previous market can never resurrect
//   old prices. Nothing stamped with generation N is ever consumable once
//   generation N+1 exists.
//
// ATOMIC SNAPSHOT (torn-read prevention):
//   Decision code MUST use `validatedQuotes()` which returns a deep-frozen
//   immutable FeedSnapshot of BOTH sides captured together, validated for
//   generation, token identity, freshness and price range, with an explicit
//   confidence grade. One engine tick = one snapshot.
//
// There is NO model, NO cache, and NO estimate. If the live values are
// not valid, `validatedQuotes()` returns null and every consumer must
// HOLD / show NO DATA rather than invent a price.
// ------------------------------------------------------------

const POLL_INTERVAL_MS = 2_000
/** REST cadence while the WS is healthy — REST demotes to a cross-check heartbeat. */
const POLL_INTERVAL_WS_HEALTHY_MS = 10_000
/** WS considered healthy when a message arrived within this window. */
const WS_HEALTHY_MS = 10_000
const STALE_MS = 15_000 // allow extra time for VPN-routed responses
const FETCH_TIMEOUT_MS = 10_000 // generous for VPN / high-latency connections

// ------------------------------------------------------------
// Stale-token detection & self-heal (INC-004 CLOB feed hardening)
// ------------------------------------------------------------
// After this many consecutive HTTP 404 responses on the current token IDs
// the feed enters STALE mode and stops normal REST polling — the tokens
// almost certainly refer to a resolved / delisted market. A self-heal
// probe then runs at `RECOVERY_PROBE_INTERVAL_MS` cadence; the moment the
// probe succeeds the feed clears its stale marker and resumes polling.
// Both are env-tunable so operators can widen / tighten the window.
const STALE_AFTER_404_COUNT = Math.max(1, Number(process.env.CLOB_STALE_AFTER_404_COUNT ?? 30))
const RECOVERY_PROBE_INTERVAL_MS = Math.max(1_000, Number(process.env.CLOB_RECOVERY_PROBE_INTERVAL_MS ?? 60_000))

// Confidence grading thresholds (max age of the older side of the pair).
const CONFIDENCE_HIGH_MAX_AGE_MS = 3_000
const CONFIDENCE_MEDIUM_MAX_AGE_MS = 10_000

// Throttle repeated "fetch failed" log lines so one bad poll does not flood
// the Intel Feed, but every DISTINCT failure reason still surfaces.
const LOG_THROTTLE_MS = 10_000

/** Distinct marker for "ask book is empty" (price returns exactly 0). */
const EMPTY_BOOK = "EMPTY_BOOK"

export type QuoteSource = "WS" | "REST"

export interface ClobQuote {
  tokenId: string
  /** Canonical price = best ask (price to BUY). Always present when set. */
  price: number
  /** Best ask (BUY) in [0,1]. */
  ask: number
  /** Best bid (SELL) in [0,1], or null if unavailable. */
  bid: number | null
  /** Book midpoint in [0,1], or null if unavailable. */
  mid: number | null
  /** Last traded price in [0,1], or null if unavailable. */
  last: number | null
  /** Side of the last trade ("BUY" | "SELL"), or null if unavailable. */
  lastSide: "BUY" | "SELL" | null
  fetchedAtMs: number
  /** Where this quote came from: WS push or REST poll. */
  source: QuoteSource
  /** Feed generation this quote belongs to (see GENERATION MODEL above). */
  generation: number
  /** Round-trip latency of the fetch that produced this quote (REST) or null (WS push). */
  latencyMs: number | null
  /** Monotonic per-feed write sequence (increments on every accepted quote write). */
  sequence: number
}

export type FeedConfidence = "HIGH" | "MEDIUM" | "LOW"

/**
 * Immutable validated pair of quotes captured atomically. This is the ONLY
 * object decision code (trigger, majority, race, fills) may consume.
 */
export interface FeedSnapshot {
  up: ClobQuote
  down: ClobQuote
  generation: number
  /** Highest write sequence contained in this snapshot. */
  sequence: number
  /** When this snapshot was assembled. */
  timestampMs: number
  upAgeMs: number
  downAgeMs: number
  /** ms since last WS message (null if WS never delivered). */
  wsFreshMs: number | null
  /** ms since last successful REST poll (null if none yet). */
  restFreshMs: number | null
  validation: "VALID"
  confidence: FeedConfidence
}

/** Aggregate order-book depth for one token (REST /book or WS snapshot). */
export interface BookDepth {
  bidLevels: number
  askLevels: number
  bidNotionalUsd: number
  askNotionalUsd: number
  fetchedAtMs: number
}

export class ClobPriceFeed {
  private upQuote: ClobQuote | null = null
  private downQuote: ClobQuote | null = null

  private upTokenId: string | null = null
  private downTokenId: string | null = null

  // --- generation model ---
  /** Monotonic generation. Bumped on every token-id change and on clear. */
  private gen = 0
  /** Monotonic quote-write sequence (never resets). */
  private seq = 0
  /** Abort in-flight REST requests when the generation moves on. */
  private genAbort: AbortController = new AbortController()
  /** Timestamp of the last generation bump (market change). */
  private lastGenerationChangeMs = 0

  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = true

  // --- diagnostic counters ---
  private consecutiveFailures = 0
  private lastSuccessMs = 0
  private lastRestUpdateMs = 0
  private lastFailMs = 0
  private lastFailLogMs = 0
  private lastFailReason = ""
  private totalPolls = 0
  private totalFailedPolls = 0
  /** Round-trip duration of the most recent successful REST poll (ms). */
  private lastApiLatencyMs: number | null = null
  /** Why the last validatedQuotes() call returned null ("" when valid). */
  private lastValidationFailReason = ""
  /** True while the ask book is empty (market listed but not tradeable yet). */
  private emptyBook = false

  // --- stale-token / self-heal state (see STALE_AFTER_404_COUNT above) ---
  private consecutive404s = 0
  private stale = false
  private staleSinceMs = 0
  private staleTokens: { up: string | null; down: string | null } = { up: null, down: null }
  private lastRecoveryProbeMs = 0
  private recoveryAttempts = 0
  private lastRecoveryOkMs = 0

  // --- order-book depth (REST /book each poll; WS book snapshots too) ---
  private upBook: BookDepth | null = null
  private downBook: BookDepth | null = null

  // --- price-change history (ask samples, ~1/s, 120s retained) ---
  // Ring buffer of canonical ask samples so the Signal Tank can show the
  // realized 60s price change instead of only the instantaneous quote.
  private priceHistory: Array<{ tsMs: number; upAsk: number; downAsk: number }> = []
  private lastHistoryPushMs = 0

  // --- WebSocket optimization layer ---
  // The WS client streams best-ask updates for near-zero-latency triggers.
  // It writes the SAME upQuote/downQuote fields the poller does. Polling
  // continues as a cross-check heartbeat (slow cadence while WS is healthy,
  // fast cadence when it is not), so behavior degrades gracefully.
  private ws: ClobWsClient
  /** Fired on every quote update (WS push or poll) so the SLO can evaluate the
   *  trigger event-driven instead of only on its own timer. */
  private onQuoteUpdate: (() => void) | null = null

  constructor() {
    this.ws = new ClobWsClient(
      (u) => this.applyWsUpdate(u),
      (b) => this.applyWsBook(b),
    )
  }

  /** Store aggregate depth from a WS full-book snapshot. */
  private applyWsBook(b: { tokenId: string; bidLevels: number; askLevels: number; bidNotionalUsd: number; askNotionalUsd: number; atMs: number }) {
    const depth: BookDepth = {
      bidLevels: b.bidLevels,
      askLevels: b.askLevels,
      bidNotionalUsd: b.bidNotionalUsd,
      askNotionalUsd: b.askNotionalUsd,
      fetchedAtMs: b.atMs,
    }
    if (b.tokenId === this.upTokenId) this.upBook = depth
    else if (b.tokenId === this.downTokenId) this.downBook = depth
  }

  /** Register a listener invoked whenever a fresh quote arrives (WS or poll). */
  setQuoteListener(fn: (() => void) | null) {
    this.onQuoteUpdate = fn
  }

  /** WS diagnostics for the Signal Tank (connection + latency visibility). */
  wsDiagnostics() {
    return this.ws.diagnostics()
  }

  /** Watchdog hook: hard-reconnect the market WebSocket (zombie recovery). */
  forceWsReconnect(reason: string) {
    this.ws.forceReconnect(reason)
  }

  /** Watchdog hook: kick an immediate REST poll (stale-quote recovery). */
  pollNow() {
    if (!this.stopped) void this.poll(true)
  }

  // ---------- public API ----------

  /** Current feed generation (bumps on every market/token change). */
  get generation(): number {
    return this.gen
  }

  get latestUp(): ClobQuote | null {
    return this.upQuote
  }
  get latestDown(): ClobQuote | null {
    return this.downQuote
  }

  /** Latest aggregate order-book depth per side (null until first snapshot). */
  get bookDepth(): { up: BookDepth | null; down: BookDepth | null } {
    return { up: this.upBook, down: this.downBook }
  }

  /**
   * ATOMIC VALIDATED SNAPSHOT — the single choke point for decision code.
   *
   * Returns a deep-frozen immutable pair of quotes, or null when the pair is
   * not currently trustworthy. Valid requires ALL of:
   *   • both quotes present
   *   • both belong to the CURRENT generation
   *   • both token IDs match the CURRENT tracked tokens
   *   • both fetched within STALE_MS
   *   • both canonical prices strictly inside (0, 1)
   *
   * The snapshot also carries a confidence grade:
   *   HIGH   — both sides WS-sourced and older side < 3s
   *   MEDIUM — any REST-sourced side or older side 3–10s
   *   LOW    — anything worse (execution must reject LOW)
   */
  validatedQuotes(): FeedSnapshot | null {
    const now = Date.now()
    const up = this.upQuote
    const down = this.downQuote

    const fail = (reason: string): null => {
      this.lastValidationFailReason = reason
      return null
    }

    if (!up || !down) return fail(!up && !down ? "no quotes yet" : !up ? "missing UP quote" : "missing DOWN quote")
    if (up.generation !== this.gen || down.generation !== this.gen) {
      return fail(`generation mismatch (up=${up.generation}, down=${down.generation}, current=${this.gen})`)
    }
    if (up.tokenId !== this.upTokenId || down.tokenId !== this.downTokenId) {
      return fail("token identity mismatch — quotes belong to a different market")
    }
    const upAgeMs = now - up.fetchedAtMs
    const downAgeMs = now - down.fetchedAtMs
    if (upAgeMs >= STALE_MS || downAgeMs >= STALE_MS) {
      return fail(`stale quote (UP ${(upAgeMs / 1000).toFixed(1)}s, DOWN ${(downAgeMs / 1000).toFixed(1)}s, limit ${STALE_MS / 1000}s)`)
    }
    if (!this.inRange(up.price) || !this.inRange(down.price)) {
      return fail(`price out of range (UP ${up.price}, DOWN ${down.price})`)
    }

    const maxAge = Math.max(upAgeMs, downAgeMs)
    let confidence: FeedConfidence
    if (up.source === "WS" && down.source === "WS" && maxAge < CONFIDENCE_HIGH_MAX_AGE_MS) {
      confidence = "HIGH"
    } else if (maxAge < CONFIDENCE_MEDIUM_MAX_AGE_MS) {
      confidence = "MEDIUM"
    } else {
      confidence = "LOW"
    }

    this.lastValidationFailReason = ""
    const wsDiag = this.ws.diagnostics()
    const snapshot: FeedSnapshot = {
      up: Object.freeze({ ...up }),
      down: Object.freeze({ ...down }),
      generation: this.gen,
      sequence: Math.max(up.sequence, down.sequence),
      timestampMs: now,
      upAgeMs,
      downAgeMs,
      wsFreshMs: wsDiag.lastMessageAtMs > 0 ? now - wsDiag.lastMessageAtMs : null,
      restFreshMs: this.lastRestUpdateMs > 0 ? now - this.lastRestUpdateMs : null,
      validation: "VALID",
      confidence,
    }
    return Object.freeze(snapshot)
  }

  /**
   * Realized ask change over the trailing window (default 60s). Returns null
   * until enough history exists. Positive = the ask rose over the window.
   */
  priceChange(windowMs = 60_000): { up: number; down: number; windowMs: number } | null {
    if (this.priceHistory.length < 2) return null
    const now = Date.now()
    const cutoff = now - windowMs
    // Oldest sample still inside the window (history is appended in order).
    const base = this.priceHistory.find((s) => s.tsMs >= cutoff) ?? this.priceHistory[0]
    const latest = this.priceHistory[this.priceHistory.length - 1]
    if (latest.tsMs - base.tsMs < 5_000) return null // need >=5s of separation
    return {
      up: Math.round((latest.upAsk - base.upAsk) * 10000) / 10000,
      down: Math.round((latest.downAsk - base.downAsk) * 10000) / 10000,
      windowMs: latest.tsMs - base.tsMs,
    }
  }

  /** Push a canonical ask sample (throttled to ~1/s, 120s retained). */
  private pushHistory() {
    const now = Date.now()
    if (now - this.lastHistoryPushMs < 1_000) return
    if (!this.upQuote || !this.downQuote) return
    this.lastHistoryPushMs = now
    this.priceHistory.push({ tsMs: now, upAsk: this.upQuote.ask, downAsk: this.downQuote.ask })
    const cutoff = now - 120_000
    while (this.priceHistory.length > 0 && this.priceHistory[0].tsMs < cutoff) {
      this.priceHistory.shift()
    }
  }

  /**
   * Diagnostic state for the Intel Feed / Signal Tank / Feed Diagnostics
   * panel. Surfaces the exact reason why prices are unavailable without
   * exposing internal fields.
   */
  diagnostics(): {
    upTokenId: string | null
    downTokenId: string | null
    upQuoteAgeMs: number | null
    downQuoteAgeMs: number | null
    consecutiveFailures: number
    lastSuccessMs: number
    lastRestUpdateMs: number
    lastFailMs: number
    lastFailReason: string
    totalPolls: number
    totalFailedPolls: number
    apiLatencyMs: number | null
    pollIntervalMs: number
    generation: number
    sequence: number
    lastGenerationChangeMs: number
    validationFailReason: string
    emptyBook: boolean
    restCadence: "FAST" | "SLOW"
    consecutive404s: number
    stale: boolean
    staleSinceMs: number
    staleTokens: { up: string | null; down: string | null }
    recoveryAttempts: number
    lastRecoveryProbeMs: number
    lastRecoveryOkMs: number
    stale404Threshold: number
    recoveryProbeIntervalMs: number
    ws: ReturnType<ClobWsClient["diagnostics"]>
  } {
    const now = Date.now()
    return {
      upTokenId: this.upTokenId,
      downTokenId: this.downTokenId,
      upQuoteAgeMs: this.upQuote ? now - this.upQuote.fetchedAtMs : null,
      downQuoteAgeMs: this.downQuote ? now - this.downQuote.fetchedAtMs : null,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessMs: this.lastSuccessMs,
      lastRestUpdateMs: this.lastRestUpdateMs,
      lastFailMs: this.lastFailMs,
      lastFailReason: this.lastFailReason,
      totalPolls: this.totalPolls,
      totalFailedPolls: this.totalFailedPolls,
      apiLatencyMs: this.lastApiLatencyMs,
      pollIntervalMs: this.wsHealthy() ? POLL_INTERVAL_WS_HEALTHY_MS : POLL_INTERVAL_MS,
      generation: this.gen,
      sequence: this.seq,
      lastGenerationChangeMs: this.lastGenerationChangeMs,
      validationFailReason: this.lastValidationFailReason,
      emptyBook: this.emptyBook,
      restCadence: this.wsHealthy() ? "SLOW" : "FAST",
      consecutive404s: this.consecutive404s,
      stale: this.stale,
      staleSinceMs: this.staleSinceMs,
      staleTokens: { ...this.staleTokens },
      recoveryAttempts: this.recoveryAttempts,
      lastRecoveryProbeMs: this.lastRecoveryProbeMs,
      lastRecoveryOkMs: this.lastRecoveryOkMs,
      stale404Threshold: STALE_AFTER_404_COUNT,
      recoveryProbeIntervalMs: RECOVERY_PROBE_INTERVAL_MS,
      ws: this.ws.diagnostics(),
    }
  }

  /**
   * True only when BOTH tokens have a live best-ask fetched within STALE_MS.
   * DISPLAY-ONLY convenience — decision code must use validatedQuotes(),
   * which additionally verifies generation and token identity atomically.
   */
  get fresh(): boolean {
    const now = Date.now()
    return (
      this.upQuote !== null &&
      this.downQuote !== null &&
      this.upQuote.generation === this.gen &&
      this.downQuote.generation === this.gen &&
      now - this.upQuote.fetchedAtMs < STALE_MS &&
      now - this.downQuote.fetchedAtMs < STALE_MS
    )
  }

  /** Bump the generation: invalidate EVERYTHING from the previous market. */
  private bumpGeneration() {
    this.gen++
    this.lastGenerationChangeMs = Date.now()
    // Abort in-flight REST requests from the old generation. Their write
    // paths also re-check the generation, so this is belt AND suspenders.
    try {
      this.genAbort.abort()
    } catch {
      /* ignore */
    }
    this.genAbort = new AbortController()
    // Clear every cached artifact of the previous generation.
    this.upQuote = null
    this.downQuote = null
    this.upBook = null
    this.downBook = null
    this.priceHistory = []
    this.emptyBook = false
    // WS quote health belongs to the OLD market's tokens: reset it so REST
    // runs at FAST cadence for the new market until its WS quotes flow.
    this.lastWsQuoteAtMs = 0
    // Stale-token state belongs to the OLD tokens: fresh tokens deserve a
    // fresh chance. Log the transition so operators can correlate rollovers
    // with prior 404 storms in the Intel Feed.
    if (this.stale) {
      const staleForSec = ((Date.now() - this.staleSinceMs) / 1000).toFixed(0)
      logEvent(
        "info",
        `[CLOB feed] token replacement — clearing stale marker (was stale for ${staleForSec}s after ${this.consecutive404s} consecutive 404s on old tokens up=${this.staleTokens.up?.slice(0, 12) ?? "-"}…, down=${this.staleTokens.down?.slice(0, 12) ?? "-"}…)`,
      )
    }
    this.consecutive404s = 0
    this.stale = false
    this.staleSinceMs = 0
    this.staleTokens = { up: null, down: null }
    this.lastRecoveryProbeMs = 0
    this.recoveryAttempts = 0
    this.lastRecoveryOkMs = 0
  }

  /**
   * Point the feed at the current slot's tokens. Idempotent and self-healing:
   * this is called every SLO tick, so it must be cheap when nothing changed but
   * must also actively recover when quotes have gone missing.
   *  • Same IDs + already fresh → no-op (the timer keeps polling).
   *  • Same IDs + NOT fresh → kick an immediate poll so a missing/stale quote
   *    recovers within one SLO tick instead of waiting on the slower timer.
   *  • New IDs → GENERATION BUMP: invalidate previous-slot prices, abort
   *    in-flight fetches, and poll immediately for the new tokens.
   */
  setTokenIds(upTokenId: string, downTokenId: string) {
    if (upTokenId === this.upTokenId && downTokenId === this.downTokenId) {
      if (!this.fresh && !this.stopped) void this.poll(true)
      return
    }
    this.upTokenId = upTokenId
    this.downTokenId = downTokenId
    this.bumpGeneration()
    // Point the WS stream at the new slot's tokens (re-subscribes if changed).
    this.ws.setAssets([upTokenId, downTokenId])
    void this.poll(true)
  }

  /** Clear token IDs (slot ended, market not listed yet). */
  clearTokenIds() {
    if (this.upTokenId === null && this.downTokenId === null) return
    this.upTokenId = null
    this.downTokenId = null
    this.bumpGeneration()
    this.ws.setAssets([])
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    // Open the low-latency stream first; the poll timer is the cross-check.
    this.ws.start()
    this.timer = setInterval(() => void this.poll(false), POLL_INTERVAL_MS)
  }

  stop() {
    this.stopped = true
    this.ws.stop()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ---------- internals ----------

  private inRange(p: number): boolean {
    return Number.isFinite(p) && p > 0 && p < 1
  }

  /** Epoch ms of the last ACCEPTED WS quote application (0 = never). The
   *  feed-level signal that the WS path is actually delivering usable quotes,
   *  not merely that the socket is open. */
  private lastWsQuoteAtMs = 0

  /** WS delivered usable data recently → REST can relax to heartbeat cadence.
   *  Healthy = a raw socket message OR an accepted quote application within
   *  the window (an open-but-silent socket counts for neither). */
  private wsHealthy(): boolean {
    const d = this.ws.diagnostics()
    const lastLifeSign = Math.max(d.connected ? d.lastMessageAtMs : 0, this.lastWsQuoteAtMs)
    return lastLifeSign > 0 && Date.now() - lastLifeSign < WS_HEALTHY_MS
  }

  /**
   * Apply a WS best-ask push. It updates the SAME quote fields the poller
   * writes, preserving the bid/mid/last from the last full poll (WS only
   * carries ask/bid) so no consumer sees a regression. Fires the quote
   * listener so the SLO can evaluate the trigger the instant price moves.
   *
   * GENERATION GUARD: the update is stamped with the CURRENT generation and
   * only applied if the token still belongs to the current market. A late
   * frame for a previous market's token is discarded.
   */
  private applyWsUpdate(u: WsBestAsk) {
    const now = u.atMs
    const gen = this.gen
    if (u.tokenId === this.upTokenId) {
      const prev = this.upQuote
      this.seq++
      this.upQuote = {
        tokenId: u.tokenId,
        price: u.ask,
        ask: u.ask,
        bid: u.bid ?? (prev?.generation === gen ? prev?.bid ?? null : null),
        mid: prev?.generation === gen ? prev?.mid ?? null : null,
        last: prev?.generation === gen ? prev?.last ?? null : null,
        lastSide: prev?.generation === gen ? prev?.lastSide ?? null : null,
        fetchedAtMs: now,
        source: "WS",
        generation: gen,
        latencyMs: null,
        sequence: this.seq,
      }
    } else if (u.tokenId === this.downTokenId) {
      const prev = this.downQuote
      this.seq++
      this.downQuote = {
        tokenId: u.tokenId,
        price: u.ask,
        ask: u.ask,
        bid: u.bid ?? (prev?.generation === gen ? prev?.bid ?? null : null),
        mid: prev?.generation === gen ? prev?.mid ?? null : null,
        last: prev?.generation === gen ? prev?.last ?? null : null,
        lastSide: prev?.generation === gen ? prev?.lastSide ?? null : null,
        fetchedAtMs: now,
        source: "WS",
        generation: gen,
        latencyMs: null,
        sequence: this.seq,
      }
    } else {
      return // update for a token we're no longer tracking (old generation)
    }
    this.lastSuccessMs = now
    this.lastWsQuoteAtMs = Date.now()
    this.consecutiveFailures = 0
    this.emptyBook = false
    this.pushHistory()
    // Event-driven trigger: notify the SLO immediately on the price move.
    if (this.onQuoteUpdate) {
      try {
        this.onQuoteUpdate()
      } catch {
        /* listener errors must never break the feed */
      }
    }
  }

  /** GET /price?token_id&side= — returns the best ask (BUY) or best bid (SELL).
   *  A price of EXACTLY 0 on the BUY side means the ask book is EMPTY (normal
   *  for a freshly-listed market) and is classified distinctly from failures. */
  private async fetchPrice(
    tokenId: string,
    side: "BUY" | "SELL",
    signal: AbortSignal,
  ): Promise<{ value: number | null; err: string | null }> {
    // `cache: "no-store"` disables the Next.js Data Cache; the `_t` timestamp
    // additionally guarantees a unique URL per tick so no CDN/edge layer can
    // ever hand back a stale snapshot of the live order book.
    const url = `${env.CLOB_HTTP_HOST}/price?token_id=${encodeURIComponent(tokenId)}&side=${side}&_t=${Date.now()}`
    try {
      const res = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      })
      if (!res.ok) {
        return { value: null, err: `HTTP ${res.status} ${res.statusText} — GET ${url}` }
      }
      const data = (await res.json()) as { price?: string | number }
      const p = Number(data.price)
      if (!this.inRange(p)) {
        if (p === 0 && side === "BUY") {
          return { value: null, err: EMPTY_BOOK }
        }
        return { value: null, err: `price out of range: got "${data.price}" from GET ${url}` }
      }
      return { value: p, err: null }
    } catch (e) {
      return { value: null, err: `${e instanceof Error ? e.message : String(e)} — GET ${url}` }
    }
  }

  /** GET /midpoint?token_id — book midpoint read directly from Polymarket. */
  private async fetchMidpoint(tokenId: string, signal: AbortSignal): Promise<number | null> {
    const url = `${env.CLOB_HTTP_HOST}/midpoint?token_id=${encodeURIComponent(tokenId)}`
    try {
      const res = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { mid?: string | number }
      const p = Number(data.mid)
      return this.inRange(p) ? p : null
    } catch {
      return null
    }
  }

  /** GET /last-trade-price?token_id — last executed trade price AND side. */
  private async fetchLast(tokenId: string, signal: AbortSignal): Promise<{ price: number; side: "BUY" | "SELL" | null } | null> {
    const url = `${env.CLOB_HTTP_HOST}/last-trade-price?token_id=${encodeURIComponent(tokenId)}`
    try {
      const res = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { price?: string | number; side?: string }
      const p = Number(data.price)
      if (!this.inRange(p)) return null
      const side = data.side === "BUY" || data.side === "SELL" ? data.side : null
      return { price: p, side }
    } catch {
      return null
    }
  }

  /** GET /book?token_id — full order book, reduced to aggregate depth stats. */
  private async fetchBook(tokenId: string, signal: AbortSignal): Promise<BookDepth | null> {
    const url = `${env.CLOB_HTTP_HOST}/book?token_id=${encodeURIComponent(tokenId)}`
    try {
      const res = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      })
      if (!res.ok) return null
      const data = (await res.json()) as {
        bids?: Array<{ price?: string | number; size?: string | number }>
        asks?: Array<{ price?: string | number; size?: string | number }>
      }
      const reduce = (levels?: Array<{ price?: string | number; size?: string | number }>) => {
        let count = 0
        let notional = 0
        for (const lvl of levels ?? []) {
          const p = Number(lvl.price)
          const s = Number(lvl.size)
          if (!this.inRange(p) || !Number.isFinite(s) || s <= 0) continue
          count++
          notional += p * s
        }
        return { count, notional: Math.round(notional * 100) / 100 }
      }
      const bids = reduce(data.bids)
      const asks = reduce(data.asks)
      return {
        bidLevels: bids.count,
        askLevels: asks.count,
        bidNotionalUsd: bids.notional,
        askNotionalUsd: asks.notional,
        fetchedAtMs: Date.now(),
      }
    } catch {
      return null
    }
  }

  /** Fetch the full quote (ask/bid/mid/last/book) for one token. */
  private async fetchQuote(
    tokenId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<{ quote: ClobQuote | null; book: BookDepth | null; askErr: string | null }> {
    const startMs = Date.now()
    const [askResult, bid, mid, lastTrade, book] = await Promise.all([
      this.fetchPrice(tokenId, "BUY", signal),
      this.fetchPrice(tokenId, "SELL", signal).then((r) => r.value),
      this.fetchMidpoint(tokenId, signal),
      this.fetchLast(tokenId, signal),
      this.fetchBook(tokenId, signal),
    ])
    // The canonical price is the ask (BUY). Without it there is no usable quote.
    if (askResult.value === null) {
      return { quote: null, book, askErr: askResult.err }
    }
    const ask = askResult.value
    return {
      quote: {
        tokenId,
        price: ask,
        ask,
        bid,
        mid,
        last: lastTrade?.price ?? null,
        lastSide: lastTrade?.side ?? null,
        fetchedAtMs: Date.now(),
        source: "REST",
        generation,
        latencyMs: Date.now() - startMs,
        sequence: 0, // stamped at write time (write may be discarded)
      },
      book,
      askErr: null,
    }
  }

  /** Until this timestamp, REST polls are skipped (HTTP 429 rate-limit backoff).
   *  WS streaming continues unaffected, so quotes stay live during backoff. */
  private restBackoffUntilMs = 0
  /** Timestamp of the last REST poll ATTEMPT (adaptive cadence bookkeeping). */
  private lastPollAttemptMs = 0

  /**
   * REST poll. `force` bypasses the adaptive-cadence skip (used for watchdog
   * kicks, token changes and stale recovery) but never bypasses 429 backoff.
   *
   * ADAPTIVE CADENCE: while the WS is healthy the REST poller relaxes to a
   * 10s cross-check heartbeat instead of hammering 10 requests every 2s —
   * this removes self-inflicted rate limiting (HTTP 429) that previously
   * made REST flaky exactly when it was needed most.
   */
  private async poll(force: boolean) {
    if (this.stopped) return
    const now = Date.now()
    // 429 backoff: when Polymarket rate-limits us, hammering the REST API
    // only extends the ban. Pause REST polling briefly; WS keeps streaming.
    if (now < this.restBackoffUntilMs) return
    // Adaptive cadence: skip timer-driven polls while WS is healthy and the
    // last REST attempt was recent enough for the heartbeat role.
    if (!force && this.wsHealthy() && now - this.lastPollAttemptMs < POLL_INTERVAL_WS_HEALTHY_MS) {
      return
    }

    const generation = this.gen
    const signal = this.genAbort.signal
    const upId = this.upTokenId
    const downId = this.downTokenId

    // No token IDs yet — market discovery is still resolving. Log only once
    // per change so the Intel Feed is not flooded during boot.
    if (!upId || !downId) {
      const reason = !upId && !downId ? "no UP or DOWN token IDs — market discovery pending" : !upId ? "missing UP token ID" : "missing DOWN token ID"
      this.logFailThrottled(reason)
      return
    }

    // STALE-TOKEN GUARD: after `STALE_AFTER_404_COUNT` consecutive 404s the
    // current tokens almost certainly point at a resolved / delisted market.
    // Stop hammering CLOB (and burning quota) and let the recovery probe
    // decide when it is safe to resume. A `force` kick (watchdog / setTokens)
    // bypasses the throttle so operators can trigger an immediate re-check.
    if (this.stale) {
      const dueForProbe = now - this.lastRecoveryProbeMs >= RECOVERY_PROBE_INTERVAL_MS
      if (!force && !dueForProbe) return
      this.lastRecoveryProbeMs = now
      this.recoveryAttempts++
      logEvent(
        "info",
        `[CLOB feed] recovery probe #${this.recoveryAttempts} — tokens up=${upId.slice(0, 12)}…, down=${downId.slice(0, 12)}… (stale for ${((now - this.staleSinceMs) / 1000).toFixed(0)}s)`,
      )
    }

    this.lastPollAttemptMs = now
    this.totalPolls++
    const pollStartMs = Date.now()
    const [upResult, downResult] = await Promise.all([
      this.fetchQuote(upId, generation, signal),
      this.fetchQuote(downId, generation, signal),
    ])

    // ---- WRITE-TIME GENERATION GUARD ----
    // If the market changed while this poll was in flight, EVERYTHING it
    // returned belongs to a dead generation. Discard wholesale: quotes,
    // books, failure accounting — none of it may touch current state.
    if (generation !== this.gen || upId !== this.upTokenId || downId !== this.downTokenId) {
      return
    }

    const up = upResult.quote
    const down = downResult.quote

    // Store aggregate book depth whenever available (independent of quote success).
    if (upResult.book) this.upBook = upResult.book
    if (downResult.book) this.downBook = downResult.book

    // --- success path ---
    if (up && down) {
      const prevUp = this.upQuote?.price ?? -1
      const prevDown = this.downQuote?.price ?? -1
      this.seq++
      up.sequence = this.seq
      this.seq++
      down.sequence = this.seq
      this.upQuote = up
      this.downQuote = down
      this.consecutiveFailures = 0
      this.lastSuccessMs = Date.now()
      this.lastRestUpdateMs = Date.now()
      this.lastApiLatencyMs = Date.now() - pollStartMs
      this.lastFailReason = ""
      // Recovered — clear stale marker and reset 404 accounting.
      if (this.stale) {
        const staleForSec = ((Date.now() - this.staleSinceMs) / 1000).toFixed(0)
        this.stale = false
        this.staleSinceMs = 0
        this.staleTokens = { up: null, down: null }
        this.lastRecoveryOkMs = Date.now()
        logEvent(
          "info",
          `[CLOB feed] recovered — CLOB responded 200 after ${this.recoveryAttempts} probe(s) (was stale for ${staleForSec}s)`,
        )
      }
      this.consecutive404s = 0
      if (this.emptyBook) {
        this.emptyBook = false
        logEvent("info", "[CLOB feed] ask book populated — market is tradeable")
      }
      this.pushHistory()
      // Log on a meaningful canonical (ask) change >= 0.5¢ to avoid flooding.
      if (Math.abs(up.price - prevUp) >= 0.005 || Math.abs(down.price - prevDown) >= 0.005) {
        logEvent("info", `CLOB ask — Up: $${up.price.toFixed(4)}, Down: $${down.price.toFixed(4)}`)
      }
      return
    }

    // --- EMPTY BOOK path (distinct from failures) ---
    // BUY price of exactly 0 = no asks listed yet. Normal for a freshly-listed
    // 5-minute market. NOT a fetch failure: no failure counters, single log
    // line per state transition. Quotes stay null → consumers HOLD.
    const upEmpty = upResult.askErr === EMPTY_BOOK
    const downEmpty = downResult.askErr === EMPTY_BOOK
    if ((upEmpty || downEmpty) && (up || upEmpty) && (down || downEmpty)) {
      if (!this.emptyBook) {
        this.emptyBook = true
        const sides = upEmpty && downEmpty ? "UP+DOWN" : upEmpty ? "UP" : "DOWN"
        logEvent("info", `[CLOB feed] ask book empty (${sides}) — market listed but not tradeable yet (HOLD)`)
      }
      // A side that DID return a valid quote is still written (stamped current).
      if (up) {
        this.seq++
        up.sequence = this.seq
        this.upQuote = up
        this.lastRestUpdateMs = Date.now()
      }
      if (down) {
        this.seq++
        down.sequence = this.seq
        this.downQuote = down
        this.lastRestUpdateMs = Date.now()
      }
      return
    }

    // --- partial or full failure path ---
    this.totalFailedPolls++
    this.consecutiveFailures++
    this.lastFailMs = Date.now()

    // HTTP 429 → engage a 15s REST backoff (WS keeps quotes flowing).
    const errText = `${upResult.askErr ?? ""} ${downResult.askErr ?? ""}`
    if (errText.includes("HTTP 429")) {
      this.restBackoffUntilMs = Date.now() + 15_000
      this.logFailThrottled("HTTP 429 rate-limited — REST polling paused 15s (WS stream continues)")
      return
    }

    // HTTP 404 → almost always a delisted / resolved market. Track and, once
    // the threshold is crossed, stop polling these tokens and let the
    // recovery probe (or a fresh setTokenIds) decide when to resume.
    const upIs404 = (upResult.askErr ?? "").includes("HTTP 404")
    const downIs404 = (downResult.askErr ?? "").includes("HTTP 404")
    if ((upIs404 || downIs404) && !up && !down) {
      this.consecutive404s++
      if (!this.stale && this.consecutive404s >= STALE_AFTER_404_COUNT) {
        this.stale = true
        this.staleSinceMs = Date.now()
        this.staleTokens = { up: upId, down: downId }
        this.lastRecoveryProbeMs = Date.now() // suppress an immediate re-probe
        this.recoveryAttempts = 0
        logEvent(
          "warn",
          `[CLOB feed] STALE tokens detected — ${this.consecutive404s} consecutive 404s on up=${upId.slice(0, 12)}…, down=${downId.slice(0, 12)}…; pausing polls, self-heal probe every ${RECOVERY_PROBE_INTERVAL_MS / 1000}s until tokens change or CLOB responds`,
        )
      }
    } else {
      // Any non-404 failure resets the 404-specific counter — we only want
      // to escalate when the tokens themselves are the problem.
      this.consecutive404s = 0
    }

    const parts: string[] = []
    if (up) {
      this.seq++
      up.sequence = this.seq
      this.upQuote = up
      this.lastRestUpdateMs = Date.now()
    } else {
      parts.push(`UP token ${upId.slice(0, 12)}… failed: ${upResult.askErr ?? "unknown error"}`)
    }
    if (down) {
      this.seq++
      down.sequence = this.seq
      this.downQuote = down
      this.lastRestUpdateMs = Date.now()
    } else {
      parts.push(`DOWN token ${downId.slice(0, 12)}… failed: ${downResult.askErr ?? "unknown error"}`)
    }

    const ageUp = this.upQuote ? `${((Date.now() - this.upQuote.fetchedAtMs) / 1000).toFixed(1)}s ago` : "never"
    const ageDown = this.downQuote ? `${((Date.now() - this.downQuote.fetchedAtMs) / 1000).toFixed(1)}s ago` : "never"
    const reason = `CLOB price fetch failed (${this.consecutiveFailures} consecutive) — ${parts.join("; ")} | last good UP: ${ageUp}, DOWN: ${ageDown} | endpoint: ${env.CLOB_HTTP_HOST}`
    this.logFailThrottled(reason)
  }

  private logFailThrottled(reason: string) {
    const now = Date.now()
    const changed = reason !== this.lastFailReason
    const throttleExpired = now - this.lastFailLogMs >= LOG_THROTTLE_MS
    if (changed || throttleExpired) {
      this.lastFailReason = reason
      this.lastFailLogMs = now
      logEvent("warn", `[CLOB feed] ${reason}`)
    }
  }
}
