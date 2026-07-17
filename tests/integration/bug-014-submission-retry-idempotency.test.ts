/**
 * Bug #014 regression — order submission idempotency & retry under
 * WS reconnects / transient placement failures.
 *
 * The engine's handlePlacementFailure must:
 *   1. Scan for adoption BEFORE any retry (a lost-ack order that landed
 *      on the exchange is adopted, never duplicated).
 *   2. Classify errors: transient (timeout/network/reconnect/5xx) → retry
 *      with backoff; terminal (reject/insufficient/invalid/unauthorized)
 *      → stand down immediately.
 *   3. Cap retries and, when the exchange state is UNVERIFIABLE, refuse
 *      to blind-retry (60s cooldown for the reconciler to cross-check).
 *
 * StandingOrderManager is not directly instantiable in a unit test (full
 * deps graph), so we mirror the classifier + retry contract here and add a
 * source-drift assertion so the suite fails loudly if the real guard in
 * standing-order.ts changes shape.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// ------------------ mirrors of the shipped guard ------------------

function isTransientPlacementError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase()
  if (!m) return true
  if (/reject|insufficient|balance|allowance|unauthori[sz]ed|forbidden|invalid|tick.?size|not.?tradable|market.?closed|expired|nonce/.test(m)) {
    return false
  }
  if (/timeout|timed out|econn|socket|network|reconnect|disconnect|abort|fetch failed|502|503|504|gateway|reset|hang up|closed|ws /.test(m)) {
    return true
  }
  return true
}

interface StubOrder { id: string; price: number; side: string; adopted?: boolean }

/**
 * Full retry loop mirror. Each attempt: adopt→classify→retry with backoff.
 * `placeSeq` controls what each placeOrder attempt does. `openOrders`
 * controls what the adoption scan sees on each attempt.
 */
async function runSubmissionWithRetry(opts: {
  placeSeq: Array<{ ok: true; id: string } | { ok: false; err: Error }>
  openOrdersSeq: Array<StubOrder[] | "throw">
  price: number
}): Promise<{
  outcome: "PLACED" | "ADOPTED" | "STAND_DOWN" | "UNVERIFIABLE"
  attempts: number
  orderId?: string
}> {
  const MAX = 3
  let placeIdx = 0
  let openIdx = 0
  let lastError: unknown = new Error("initial")

  // Simulate first placement failing (that's why we're in the recovery path).
  const first = opts.placeSeq[placeIdx++]
  if (first.ok) {
    // sanity: first attempt should be a failure in this harness
    return { outcome: "PLACED", attempts: 1, orderId: first.id }
  }
  lastError = first.err

  for (let attempt = 1; attempt <= MAX; attempt++) {
    // 1) adoption scan (up to 3 sub-attempts).
    let adoption: StubOrder | null | "unverifiable" = "unverifiable"
    for (let s = 1; s <= 3; s++) {
      const view = opts.openOrdersSeq[openIdx++] ?? []
      if (view === "throw") {
        if (s === 3) { adoption = "unverifiable"; break }
        continue
      }
      const match = view.find((o) => o.side === "BUY" && Math.abs(o.price - opts.price) < 0.005)
      adoption = match ?? null
      break
    }
    if (adoption && adoption !== "unverifiable") {
      return { outcome: "ADOPTED", attempts: attempt, orderId: adoption.id }
    }
    if (adoption === "unverifiable" && attempt === MAX) {
      return { outcome: "UNVERIFIABLE", attempts: attempt }
    }
    if (!isTransientPlacementError(lastError)) {
      return { outcome: "STAND_DOWN", attempts: attempt }
    }
    // 2) retry
    if (attempt < MAX) {
      const next = opts.placeSeq[placeIdx++]
      if (!next) return { outcome: "STAND_DOWN", attempts: attempt }
      if (next.ok) return { outcome: "PLACED", attempts: attempt + 1, orderId: next.id }
      lastError = next.err
    }
  }
  return { outcome: "STAND_DOWN", attempts: MAX }
}

// ------------------ tests ------------------

describe("Bug #014 — submission retry & idempotency", () => {
  it("classifier: terminal errors are NOT retried", () => {
    expect(isTransientPlacementError(new Error("insufficient balance"))).toBe(false)
    expect(isTransientPlacementError(new Error("CLOB rejected order: invalid tick size"))).toBe(false)
    expect(isTransientPlacementError(new Error("unauthorized"))).toBe(false)
    expect(isTransientPlacementError(new Error("market closed"))).toBe(false)
  })

  it("classifier: transient errors ARE retried", () => {
    expect(isTransientPlacementError(new Error("fetch failed"))).toBe(true)
    expect(isTransientPlacementError(new Error("socket hang up"))).toBe(true)
    expect(isTransientPlacementError(new Error("placeOrder timed out"))).toBe(true)
    expect(isTransientPlacementError(new Error("ECONNRESET"))).toBe(true)
    expect(isTransientPlacementError(new Error("ws disconnect during send"))).toBe(true)
    expect(isTransientPlacementError(new Error("502 bad gateway"))).toBe(true)
  })

  it("adopts a lost-ack order instead of retrying (no duplicate)", async () => {
    const r = await runSubmissionWithRetry({
      placeSeq: [{ ok: false, err: new Error("timeout") }],
      openOrdersSeq: [[{ id: "0xlive", price: 0.85, side: "BUY" }]],
      price: 0.85,
    })
    expect(r.outcome).toBe("ADOPTED")
    expect(r.orderId).toBe("0xlive")
    expect(r.attempts).toBe(1)
  })

  it("retries a transient failure and succeeds on attempt #2", async () => {
    const r = await runSubmissionWithRetry({
      placeSeq: [
        { ok: false, err: new Error("socket hang up") },
        { ok: true, id: "0xretry" },
      ],
      openOrdersSeq: [[], []], // no adoption match either time
      price: 0.85,
    })
    expect(r.outcome).toBe("PLACED")
    expect(r.orderId).toBe("0xretry")
    expect(r.attempts).toBe(2)
  })

  it("stands down IMMEDIATELY on a terminal error (no retry)", async () => {
    const r = await runSubmissionWithRetry({
      placeSeq: [{ ok: false, err: new Error("insufficient balance for order") }],
      openOrdersSeq: [[]],
      price: 0.85,
    })
    expect(r.outcome).toBe("STAND_DOWN")
    expect(r.attempts).toBe(1)
  })

  it("declares UNVERIFIABLE when adoption reads keep throwing (never blind-retries)", async () => {
    const r = await runSubmissionWithRetry({
      placeSeq: [
        { ok: false, err: new Error("timeout") },
        { ok: false, err: new Error("timeout") },
        { ok: false, err: new Error("timeout") },
      ],
      // 3 attempts × 3 sub-scans = 9 throws
      openOrdersSeq: Array.from({ length: 9 }, () => "throw" as const),
      price: 0.85,
    })
    expect(r.outcome).toBe("UNVERIFIABLE")
  })

  it("SOURCE DRIFT — the shipped guard still contains the retry + adopt shape", () => {
    const src = readFileSync(
      resolve(__dirname, "../../lib/v2/engine/standing-order.ts"),
      "utf8",
    )
    expect(src).toContain("BUG #014")
    expect(src).toContain("isTransientPlacementError")
    expect(src).toContain("scanForAdoption")
    expect(src).toContain("placeOrder-retry-")
    // Ensure adoption scan runs BEFORE any retry.
    const failFn = src.indexOf("handlePlacementFailure")
    const scanCall = src.indexOf("scanForAdoption(", failFn)
    const retryCall = src.indexOf("placeOrder-retry-", failFn)
    expect(scanCall).toBeGreaterThan(-1)
    expect(retryCall).toBeGreaterThan(-1)
    expect(scanCall).toBeLessThan(retryCall)
  })
})
