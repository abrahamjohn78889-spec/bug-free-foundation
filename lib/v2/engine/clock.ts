import { SLOT_MS } from "./config"
import { logEvent } from "./events"

// ------------------------------------------------------------
// Millisecond-synced candle clock.
// We compute a drift offset against an external time authority
// (Binance server time, an exchange-grade NTP proxy) so the
// T-20s / T-10s / T-2s gates fire on true wall-clock boundaries
// even if the VPS clock drifts.
// ------------------------------------------------------------

let offsetMs = 0
let synced = false
let syncTimer: ReturnType<typeof setInterval> | null = null

export function clockOffsetMs() {
  return offsetMs
}

export function clockSynced() {
  return synced
}

/** Corrected epoch milliseconds */
export function nowMs(): number {
  return Date.now() + offsetMs
}

/** End of the current 5-minute slot (epoch ms) */
export function currentSlotEndMs(): number {
  return Math.ceil(nowMs() / SLOT_MS) * SLOT_MS
}

/** Milliseconds remaining in the current slot */
export function tMinusMs(): number {
  return currentSlotEndMs() - nowMs()
}

/** Start of the current slot, used to capture the candle strike */
export function currentSlotStartMs(): number {
  return currentSlotEndMs() - SLOT_MS
}

export function marketIdForSlot(slotEndMs: number): string {
  const d = new Date(slotEndMs)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `BTC-5M-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
}

// Ordered time-authority cascade. Binance is geo-blocked in some
// regions, so Coinbase and Polymarket's own CLOB clock act as
// fallbacks — the engine syncs as long as any one is reachable.
const AUTH_TIMEOUT_MS = 4_000

interface TimeAuthority {
  name: string
  /** Resolve the authority's current epoch milliseconds. */
  fetchServerMs: () => Promise<number>
}

const AUTHORITIES: TimeAuthority[] = [
  {
    name: "binance",
    fetchServerMs: async () => {
      const res = await fetch("https://api.binance.com/api/v3/time", { cache: "no-store", signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`binance time ${res.status}`)
      const body = (await res.json()) as { serverTime: number }
      if (!Number.isFinite(body.serverTime)) throw new Error("binance time malformed")
      return body.serverTime
    },
  },
  {
    name: "coinbase",
    fetchServerMs: async () => {
      const res = await fetch("https://api.exchange.coinbase.com/time", { cache: "no-store", signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`coinbase time ${res.status}`)
      const body = (await res.json()) as { epoch: number }
      if (!Number.isFinite(body.epoch)) throw new Error("coinbase time malformed")
      return Math.round(body.epoch * 1000)
    },
  },
  {
    name: "polymarket-clob",
    fetchServerMs: async () => {
      const res = await fetch("https://clob.polymarket.com/time", { cache: "no-store", signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`clob time ${res.status}`)
      const text = (await res.text()).trim()
      const seconds = Number(text.replaceAll('"', ""))
      if (!Number.isFinite(seconds)) throw new Error("clob time malformed")
      return Math.round(seconds * 1000)
    },
  },
]

let syncFailureLogged = false

async function syncOnce() {
  for (const authority of AUTHORITIES) {
    try {
      const t0 = Date.now()
      const serverMs = await authority.fetchServerMs()
      const t1 = Date.now()
      const rtt = t1 - t0
      const estimatedServerNow = serverMs + rtt / 2
      offsetMs = Math.round(estimatedServerNow - t1)
      if (!synced) logEvent("info", `Clock synced via ${authority.name}. Drift offset ${offsetMs}ms (rtt ${rtt}ms)`)
      synced = true
      syncFailureLogged = false
      return
    } catch {
      // try the next authority in the cascade
    }
  }
  if (!synced && !syncFailureLogged) {
    syncFailureLogged = true
    logEvent("warn", "All time authorities unreachable, falling back to local system time")
  }
}

export function startClockSync() {
  if (syncTimer) return
  // Immediately attempt sync on startup (blocks nothing, purely async)
  void syncOnce()
  // Re-sync every 60 seconds to account for clock drift
  syncTimer = setInterval(() => void syncOnce(), 60_000)
}

export function stopClockSync() {
  if (syncTimer) clearInterval(syncTimer)
  syncTimer = null
}
