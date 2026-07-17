// Shared in-memory CLOB price feed double for the SLO integration suites.
// Exposes exactly the surface the StandingOrderManager consumes — including
// the Phase 1 atomic-snapshot API (validatedQuotes / generation) — so every
// suite drives the SAME decision path production uses.
import type { FeedSnapshot } from "@/lib/v2/engine/feeds/clob-price-feed"

export class FakeClobFeed {
  private up: number | null = null
  private down: number | null = null
  freshFlag = true
  listener: (() => void) | null = null
  /** Feed generation — tests may bump this to simulate a market change. */
  gen = 1
  private seqCounter = 0
  /** Confidence stamped onto snapshots (tests may set "LOW" to verify rejection). */
  confidence: "HIGH" | "MEDIUM" | "LOW" = "HIGH"

  setPrices(up: number | null, down: number | null) {
    this.up = up
    this.down = down
  }

  get fresh(): boolean {
    return this.freshFlag && this.up !== null && this.down !== null
  }

  get generation(): number {
    return this.gen
  }

  get latestUp() {
    return this.up === null ? null : { price: this.up, bid: null, mid: null, last: null, fetchedAtMs: Date.now() }
  }

  get latestDown() {
    return this.down === null ? null : { price: this.down, bid: null, mid: null, last: null, fetchedAtMs: Date.now() }
  }

  /** Phase 1 atomic snapshot — mirrors the real feed's contract: null unless
   *  both sides are present and the feed is flagged fresh. */
  validatedQuotes(): FeedSnapshot | null {
    if (!this.fresh) return null
    const now = Date.now()
    const quote = (tokenId: string, price: number) =>
      Object.freeze({
        tokenId,
        price,
        ask: price,
        bid: null,
        mid: null,
        last: null,
        lastSide: null,
        fetchedAtMs: now,
        source: "REST" as const,
        generation: this.gen,
        latencyMs: 5,
        sequence: ++this.seqCounter,
      })
    return Object.freeze({
      up: quote("up-token", this.up!),
      down: quote("down-token", this.down!),
      generation: this.gen,
      sequence: this.seqCounter,
      timestampMs: now,
      upAgeMs: 0,
      downAgeMs: 0,
      wsFreshMs: null,
      restFreshMs: 0,
      validation: "VALID" as const,
      confidence: this.confidence,
    })
  }

  setQuoteListener(fn: (() => void) | null) {
    this.listener = fn
  }
  setTokenIds() {}
  clearTokenIds() {}

  diagnostics() {
    return {
      upTokenId: "up-token",
      downTokenId: "down-token",
      upQuoteAgeMs: 0,
      downQuoteAgeMs: 0,
      consecutiveFailures: 0,
      lastFailReason: "",
      lastSuccessMs: Date.now(),
      generation: this.gen,
      validationFailReason: this.fresh ? "" : "no quotes yet",
    }
  }
}
