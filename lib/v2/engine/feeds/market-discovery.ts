import { env, SLOT_MS } from "../config"
import { logEvent } from "../events"
import type { TradeSide } from "../types"

// ------------------------------------------------------------
// Gamma API market discovery for the 5-minute BTC Up/Down series.
//
// Polymarket publishes each candle as a market with the slug
//   btc-updown-5m-<slotEndEpochSeconds>
// e.g. btc-updown-5m-1783523400 for the candle ending at that
// epoch second. The Gamma record carries the real conditionId
// and the two CLOB token ids (Up first, Down second) that the
// LIVE_V2 executor must sign orders against.
//
// This module resolves + caches those records per slot, and can
// also read the market's official resolution (Chainlink BTC/USD
// stream) after close so live settlement never relies on our
// local spot feed.
// ------------------------------------------------------------

export interface DiscoveredMarket {
  slotEndMs: number
  slug: string
  question: string
  conditionId: string
  upTokenId: string
  downTokenId: string
  orderMinSize: number
  tickSize: number
  active: boolean
  closed: boolean
  /** Cumulative traded volume in USD reported by Gamma (null when absent). */
  volumeUsd: number | null
  /** Gamma-reported liquidity in USD (null when absent). */
  liquidityUsd: number | null
  /** Official market end/resolution time (ISO), from Gamma (null when absent). */
  endDateIso: string | null
}

interface GammaMarket {
  question?: string
  conditionId?: string
  slug?: string
  outcomes?: string
  outcomePrices?: string
  clobTokenIds?: string
  orderMinSize?: number
  orderPriceMinTickSize?: number
  active?: boolean
  closed?: boolean
  umaResolutionStatus?: string
  volumeNum?: number | string
  volume?: number | string
  liquidityNum?: number | string
  liquidity?: number | string
  endDate?: string
}

const FETCH_TIMEOUT_MS = 12_000 // generous for VPN / high-latency connections

export function slugForSlot(slotEndMs: number): string {
  // CRITICAL: Polymarket keys each 5-minute market's slug to the epoch second
  // at which the window STARTS, e.g. the market resolving at 8:30 ET
  // (slotEndMs) has slug btc-updown-5m-<8:25 epoch>. Our engine tracks
  // slotEndMs (the RESOLUTION boundary), which is SLOT_MS after the window
  // start. Using slotEndMs directly built the slug for the NEXT window — a
  // not-yet-live market frozen at its opening ~0.50/0.50 — so the feed never
  // saw the live market move. Subtract one slot to hit the active market.
  return `btc-updown-5m-${Math.round((slotEndMs - SLOT_MS) / 1000)}`
}

async function fetchGammaMarketWithParams(slug: string, extraParams: string): Promise<GammaMarket | null> {
  const url = `${env.GAMMA_HTTP_HOST}/markets?slug=${encodeURIComponent(slug)}${extraParams}`
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) {
    // Carry a body excerpt in the error so failures remain diagnosable from
    // the caller's logEvent without per-request debug logging.
    const body = await res.text().catch(() => "")
    throw new Error(`gamma query failed: ${res.status}${body ? ` — ${body.slice(0, 160)}` : ""}`)
  }
  const list = (await res.json()) as GammaMarket[]
  if (!Array.isArray(list) || list.length === 0) return null
  return list[0]
}

async function fetchGammaMarket(slug: string): Promise<GammaMarket | null> {
  // ROOT-CAUSE FIX (settlement integrity): Gamma's default /markets?slug=
  // query EXCLUDES closed markets. A 5-minute market disappears from the
  // default response within seconds of resolving (closed flips ~15-30s after
  // candle close). fetchResolution was therefore structurally unable to EVER
  // read an official outcome: before resolution the market was open (not yet
  // resolved), and after resolution it vanished from the query — so every
  // settlement silently fell through to the spot fallback or SCRATCH. The
  // fix: when the default query returns nothing, retry with closed=true so
  // resolved markets remain queryable for official settlement.
  const open = await fetchGammaMarketWithParams(slug, "")
  if (open) return open
  return fetchGammaMarketWithParams(slug, "&closed=true")
}

/**
 * Standalone official-resolution reader shared by MarketDiscovery and the
 * post-settlement verifier. Maps the winner from the resolved market's
 * outcome prices BY OUTCOME LABEL (never positional), and only when the
 * market is closed or UMA-resolved. Returns null while pending — never
 * guesses.
 */
export async function fetchOfficialResolution(slotEndMs: number): Promise<TradeSide | null> {
  try {
    const raw = await fetchGammaMarket(slugForSlot(slotEndMs))
    if (!raw?.outcomePrices || !raw.outcomes) return null
    const prices = (JSON.parse(raw.outcomePrices) as string[]).map(Number)
    const outcomes = JSON.parse(raw.outcomes) as string[]
    if (!raw.closed && raw.umaResolutionStatus !== "resolved") return null
    const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up")
    if (upIdx < 0 || !Number.isFinite(prices[upIdx])) return null
    // After resolution the winning outcome trades at 1.00.
    if (prices[upIdx] >= 0.99) return "UP"
    if (prices[upIdx] <= 0.01) return "DOWN"
    return null
  } catch {
    return null
  }
}

function parseMarket(slotEndMs: number, raw: GammaMarket): DiscoveredMarket | null {
  if (!raw.conditionId || !raw.clobTokenIds) return null
  let tokenIds: string[]
  let outcomes: string[]
  try {
    tokenIds = JSON.parse(raw.clobTokenIds) as string[]
    outcomes = raw.outcomes ? (JSON.parse(raw.outcomes) as string[]) : ["Up", "Down"]
  } catch {
    return null
  }
  if (tokenIds.length < 2) return null

  // Map token ids by outcome label rather than trusting positional order.
  const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up")
  const downIdx = outcomes.findIndex((o) => o.toLowerCase() === "down")
  const upTokenId = tokenIds[upIdx >= 0 ? upIdx : 0]
  const downTokenId = tokenIds[downIdx >= 0 ? downIdx : 1]

  return {
    slotEndMs,
    slug: raw.slug ?? slugForSlot(slotEndMs),
    question: raw.question ?? "",
    conditionId: raw.conditionId,
    upTokenId,
    downTokenId,
    orderMinSize: Number(raw.orderMinSize ?? 5),
    tickSize: Number(raw.orderPriceMinTickSize ?? 0.01),
    // Gamma can return null for active/closed on newly-listed or pending markets.
    // Treat null/undefined as false — a freshly-listed market that hasn't opened
    // yet will have active=null until Polymarket flips the flag.
    active: raw.active === true,
    closed: raw.closed === true,
    volumeUsd: toFiniteOrNull(raw.volumeNum ?? raw.volume),
    liquidityUsd: toFiniteOrNull(raw.liquidityNum ?? raw.liquidity),
    endDateIso: typeof raw.endDate === "string" && raw.endDate.length > 0 ? raw.endDate : null,
  }
}

/** Coerce a Gamma numeric-ish field to a finite number or null. */
function toFiniteOrNull(v: number | string | undefined): number | null {
  if (v === undefined || v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Backoff table: after N consecutive failures, wait this long before retrying.
const BACKOFF_MS = [0, 2_000, 5_000, 10_000, 20_000, 30_000]
const MAX_BACKOFF_MS = 30_000

export class MarketDiscovery {
  private cache = new Map<number, DiscoveredMarket>()
  private inflight = new Map<number, Promise<DiscoveredMarket | null>>()
  private missLoggedFor = 0
  // Backoff state per slot: tracks consecutive failures and the timestamp of
  // the last attempt so callers can skip redundant retries.
  private failCount = new Map<number, number>()
  private lastAttemptMs = new Map<number, number>()

  /** Cached record for a slot, if already resolved. */
  peek(slotEndMs: number): DiscoveredMarket | null {
    return this.cache.get(slotEndMs) ?? null
  }

  /**
   * Refresh a cached market record from Gamma. Called periodically while a
   * position is held so the `closed`/`active` flags stay current. A market
   * that has resolved will have `closed=true` and `outcomePrices` reflecting
   * the winning side. We update the cache in place so `fetchResolution` and
   * the snapshot both see the latest state without a full re-resolve.
   */
  async refreshMarket(slotEndMs: number): Promise<DiscoveredMarket | null> {
    try {
      const raw = await fetchGammaMarket(slugForSlot(slotEndMs))
      if (!raw) return this.cache.get(slotEndMs) ?? null
      const fresh = parseMarket(slotEndMs, raw)
      if (fresh) {
        const prev = this.cache.get(slotEndMs)
        this.cache.set(slotEndMs, fresh)
        // Log only when closed state changes to avoid repeated log spam.
        if (fresh.closed && !prev?.closed) {
          logEvent("info", `Market closed: ${fresh.slug} (active=${fresh.active}, closed=${fresh.closed})`)
        }
        return fresh
      }
    } catch (e) {
      // Never throw from a background refresh — log at warn for visibility.
      logEvent("warn", `refreshMarket failed for slot ${slotEndMs}: ${e instanceof Error ? e.message : String(e)}`)
    }
    return this.cache.get(slotEndMs) ?? null
  }

  /**
   * Resolve the real Polymarket market for a slot. Deduplicates
   * concurrent calls and caches successes. Returns null (without
   * throwing) when the market is not yet listed or Gamma is down,
   * so the 50ms decision loop is never blocked by discovery.
   *
   * Markets are published after they close, so we also check for
   * recently-closed slots (the 5-min window before the target) to
   * find a market that might already be resolved. This helps avoid
   * the "cold start" problem where future slots don't exist yet.
   */
  async resolve(slotEndMs: number): Promise<DiscoveredMarket | null> {
    const cached = this.cache.get(slotEndMs)
    if (cached) return cached

    const pending = this.inflight.get(slotEndMs)
    if (pending) return pending

    // Exponential backoff: skip the fetch if we failed recently.
    const failures = this.failCount.get(slotEndMs) ?? 0
    const waitMs = Math.min(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)], MAX_BACKOFF_MS)
    const lastMs = this.lastAttemptMs.get(slotEndMs) ?? 0
    if (waitMs > 0 && Date.now() - lastMs < waitMs) {
      return null
    }

    const task = (async () => {
      this.lastAttemptMs.set(slotEndMs, Date.now())
      try {
        const raw = await fetchGammaMarket(slugForSlot(slotEndMs))
        const market = raw ? parseMarket(slotEndMs, raw) : null
        if (market) {
          this.cache.set(slotEndMs, market)
          this.failCount.delete(slotEndMs)
          this.lastAttemptMs.delete(slotEndMs)
          this.prune()
          logEvent("info", `Market resolved: ${market.question || market.slug} (cond ${market.conditionId.slice(0, 10)}...)`)
          return market
        }

        // If the target slot isn't listed yet, it might be because
        // Gamma lags. Check if there's a recently-closed market we
        // can fallback to for immediate discovery (common during
        // rapid-fire candle windows).
        if (slotEndMs % 300_000 === 0) {
          // This is a 5-minute boundary; check the previous slot.
          const prevSlotMs = slotEndMs - 5 * 60 * 1000
          const prevRaw = await fetchGammaMarket(slugForSlot(prevSlotMs))
          if (prevRaw && prevRaw.closed) {
            const prevMarket = parseMarket(prevSlotMs, prevRaw)
            if (prevMarket) {
              this.cache.set(prevSlotMs, prevMarket)
              logEvent("info", `Market pre-cached from previous slot (${prevMarket.slug}) — current slot listing pending`)
            }
          }
        }

        this.failCount.set(slotEndMs, (this.failCount.get(slotEndMs) ?? 0) + 1)
        if (this.missLoggedFor !== slotEndMs) {
          this.missLoggedFor = slotEndMs
          const f = this.failCount.get(slotEndMs) ?? 1
          const nextRetryMs = Math.min(BACKOFF_MS[Math.min(f, BACKOFF_MS.length - 1)], MAX_BACKOFF_MS)
          logEvent("warn", `Gamma has no listing yet for ${slugForSlot(slotEndMs)} — will retry in ${nextRetryMs / 1000}s`)
        }
        return null
      } catch (e) {
        this.failCount.set(slotEndMs, (this.failCount.get(slotEndMs) ?? 0) + 1)
        if (this.missLoggedFor !== slotEndMs) {
          this.missLoggedFor = slotEndMs
          const f = this.failCount.get(slotEndMs) ?? 1
          const nextRetryMs = Math.min(BACKOFF_MS[Math.min(f, BACKOFF_MS.length - 1)], MAX_BACKOFF_MS)
          logEvent("warn", `Market discovery failed for ${slugForSlot(slotEndMs)}: ${e instanceof Error ? e.message : String(e)} — retry in ${nextRetryMs / 1000}s`)
        }
        return null
      } finally {
        this.inflight.delete(slotEndMs)
      }
    })()

    this.inflight.set(slotEndMs, task)
    return task
  }

  /**
   * Official winner for a settled slot, read from the market's
   * post-resolution outcome prices (Chainlink-sourced). Returns
   * null while UMA/Chainlink resolution is still pending.
   */
  async fetchResolution(slotEndMs: number): Promise<TradeSide | null> {
    return fetchOfficialResolution(slotEndMs)
  }

  private prune() {
    // Keep only the most recent handful of slots.
    if (this.cache.size <= 8) return
    const keys = [...this.cache.keys()].sort((a, b) => a - b)
    for (const k of keys.slice(0, keys.length - 8)) {
      this.cache.delete(k)
      this.failCount.delete(k)
      this.lastAttemptMs.delete(k)
    }
  }
}
