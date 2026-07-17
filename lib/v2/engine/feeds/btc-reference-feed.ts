import { env } from "../config"
import { logEvent } from "../events"
import type { SpotTick } from "../types"

// ------------------------------------------------------------
// BTC reference price feed (DISPLAY ONLY).
//
// The Bitcoin reference price is sourced from Chainlink and shown
// separately from the Polymarket contract prices. It is NEVER used to
// derive UP/DOWN contract values, majority side, trigger detection, or
// Standing Limit Order execution — those come exclusively from the live
// Polymarket CLOB.
//
// The feed is defined behind an interface so the current on-chain
// aggregator implementation can be swapped for the low-latency Chainlink
// Data Streams API later (once credentials exist) without touching any
// consumer.
// ------------------------------------------------------------

export type BtcTickListener = (tick: SpotTick) => void

export interface BtcReferenceFeed {
  readonly latest: SpotTick | null
  onTick(fn: BtcTickListener): () => void
  start(): void
  stop(): void
}

// Chainlink AggregatorV3Interface function selectors (first 4 bytes of the
// keccak256 of the signature). We read the aggregator with raw eth_call via
// fetch so no web3 dependency is required.
const SELECTOR_LATEST_ROUND_DATA = "0xfeaf968c" // latestRoundData()
const SELECTOR_DECIMALS = "0x313ce567" // decimals()

const POLL_INTERVAL_MS = 3_000
const RPC_TIMEOUT_MS = 4_000

/**
 * Reads the on-chain Chainlink BTC/USD aggregator via a public RPC using raw
 * JSON-RPC eth_call. No credentials or web3 library required. Latency is a few
 * seconds — perfectly fine for a display-only reference price.
 */
export class ChainlinkOnchainFeed implements BtcReferenceFeed {
  private decimals = 8
  private lastTick: SpotTick | null = null
  private listeners = new Set<BtcTickListener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = true
  private decimalsResolved = false
  // One or more comma-separated RPC endpoints; we rotate to the next on failure.
  private rpcUrls: string[] = env.CHAINLINK_RPC_URL.split(",")
    .map((u) => u.trim())
    .filter(Boolean)
  private rpcIndex = 0

  get latest(): SpotTick | null {
    return this.lastTick
  }

  onTick(fn: BtcTickListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private currentRpc(): string {
    return this.rpcUrls[this.rpcIndex] ?? this.rpcUrls[0] ?? "https://polygon-bor-rpc.publicnode.com"
  }

  /** Advance to the next RPC endpoint after a failure. */
  private rotateRpc() {
    if (this.rpcUrls.length > 1) this.rpcIndex = (this.rpcIndex + 1) % this.rpcUrls.length
  }

  /**
   * Raw eth_call against the configured aggregator; returns the hex result.
   * On network/HTTP/JSON-RPC error it rotates to the next RPC and returns null.
   */
  private async ethCall(data: string): Promise<string | null> {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS)
    try {
      const res = await fetch(this.currentRpc(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: env.CHAINLINK_BTC_USD_FEED, data }, "latest"],
        }),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        this.rotateRpc()
        return null
      }
      const json = (await res.json()) as { result?: string; error?: unknown }
      if (json.error || !json.result) {
        this.rotateRpc()
        return null
      }
      return json.result
    } catch {
      this.rotateRpc()
      return null
    } finally {
      clearTimeout(to)
    }
  }

  private async poll() {
    if (this.stopped) return
    try {
      if (!this.decimalsResolved) {
        const decHex = await this.ethCall(SELECTOR_DECIMALS)
        if (decHex && decHex.length >= 3) {
          const d = Number(BigInt(decHex))
          if (Number.isFinite(d) && d > 0 && d <= 30) this.decimals = d
        }
        this.decimalsResolved = true
      }
      const result = await this.ethCall(SELECTOR_LATEST_ROUND_DATA)
      // latestRoundData returns 5 x 32-byte words; answer (int256) is word #2.
      if (!result || result.length < 2 + 64 * 2) return
      const answerHex = result.slice(2 + 64, 2 + 64 * 2)
      const price = Number(BigInt("0x" + answerHex)) / 10 ** this.decimals
      if (Number.isFinite(price) && price > 0) {
        const prev = this.lastTick?.price ?? -1
        const tick: SpotTick = { price, tsMs: Date.now(), source: "chainlink-onchain" }
        this.lastTick = tick
        for (const fn of this.listeners) fn(tick)
        // Log only on a meaningful move (>= $5) to avoid flooding the feed.
        if (Math.abs(price - prev) >= 5) {
          logEvent(
            "info",
            `Chainlink BTC/USD reference: $${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
          )
        }
      }
    } catch {
      // Transient RPC failure — keep the last tick, retry next interval.
    }
  }
}

/**
 * Factory that returns the configured BTC reference feed. Adding the
 * Data Streams implementation later is a one-line switch here.
 */
export function makeBtcReferenceFeed(): BtcReferenceFeed {
  switch (env.BTC_REFERENCE_SOURCE) {
    case "chainlink-datastreams":
      // Not yet implemented — falls back to on-chain until credentials + the
      // Data Streams client are wired. Kept as an explicit branch so the
      // swap is obvious and isolated.
      logEvent("warn", "Chainlink Data Streams not configured — using on-chain Chainlink feed")
      return new ChainlinkOnchainFeed()
    case "chainlink-onchain":
    default:
      return new ChainlinkOnchainFeed()
  }
}
