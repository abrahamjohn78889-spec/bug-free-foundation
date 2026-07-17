/**
 * Settlement Integrity Regression Suite
 *
 * Guards the fixes from the trade-ecac0be7 forensic investigation:
 *
 *  1. ROOT CAUSE — Gamma's default /markets?slug= query excludes closed
 *     markets, so official resolutions were structurally unreachable and
 *     every settlement fell through to the spot fallback. Fix: retry with
 *     closed=true. (fetchOfficialResolution)
 *  2. Slug mapping — settlement must query the SAME market that was traded
 *     (slot-start-keyed slug), never the next window.
 *  3. Outcome mapping — winner is derived from outcome LABELS, never
 *     positional indices, and only from resolved/closed markets.
 *  4. Verifier — post-settlement sweep flags ledger-vs-official mismatches
 *     as CRITICAL without silently auto-correcting the ledger.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { fetchOfficialResolution, slugForSlot } from "@/lib/v2/engine/feeds/market-discovery"
import { verifySettlements } from "@/lib/v2/engine/settlement-verifier"
import { computeExpected, bookedPayout, repairTrade, type RepairableTrade } from "@/lib/v2/engine/settlement-repair"
import { Bankroll } from "@/lib/v2/engine/bankroll"
import { openTrade, settleTrade, flushWriteQueueSync, kvGet, getDbHandle } from "@/lib/v2/engine/db"

const MODE = "PAPER_V1" as const
const DB_FILE = process.env.DB_PATH || "data/test-ledger.db"

// ---------------------------------------------------------------------------
// Gamma API mock
// ---------------------------------------------------------------------------

type GammaFixture = {
  /** Response for the default (open-only) query. */
  open?: unknown[]
  /** Response for the closed=true retry. */
  closed?: unknown[]
}

let fixture: GammaFixture = {}
let requestedUrls: string[] = []

function gammaMarket(overrides: Record<string, unknown> = {}) {
  return {
    slug: "btc-updown-5m-1783949100",
    outcomes: JSON.stringify(["Up", "Down"]),
    outcomePrices: JSON.stringify(["1", "0"]),
    closed: true,
    active: false,
    umaResolutionStatus: "resolved",
    ...overrides,
  }
}

beforeEach(() => {
  fixture = {}
  requestedUrls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requestedUrls.push(url)
      // Telegram notify calls (mismatch alerts) — accept silently.
      if (url.includes("api.telegram.org")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      const body = url.includes("closed=true") ? (fixture.closed ?? []) : (fixture.open ?? [])
      return new Response(JSON.stringify(body), { status: 200 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  // Remove seeded trades from the shared per-worker DB. The seeded LOSS
  // (settled "today") would otherwise count toward the daily-loss risk cap
  // and block order submission in suites that share this worker (e.g.
  // sizing-and-window), causing order-count flakes.
  flushWriteQueueSync()
  // Use the engine's own handle: it runs migrations on first open, so the
  // cleanup works even when this suite runs standalone in a fresh worker DB.
  getDbHandle().prepare("DELETE FROM trades WHERE trade_uid LIKE 'verify-%'").run()
})

// ---------------------------------------------------------------------------
// 1 + 3. fetchOfficialResolution — closed-market retry and outcome mapping
// ---------------------------------------------------------------------------

describe("fetchOfficialResolution (root-cause regression)", () => {
  const slotEndMs = 1_783_949_400_000 // any 5m boundary

  it("finds the official winner via the closed=true retry when the default query is empty", async () => {
    fixture.open = [] // <- the exact production failure: resolved market vanished
    fixture.closed = [gammaMarket({ outcomePrices: JSON.stringify(["0", "1"]) })]
    const winner = await fetchOfficialResolution(slotEndMs)
    expect(winner).toBe("DOWN")
    // Must have actually issued the closed=true retry.
    expect(requestedUrls.some((u) => u.includes("closed=true"))).toBe(true)
  })

  it("resolves UP when the Up outcome settles at 1.00", async () => {
    fixture.closed = [gammaMarket({ outcomePrices: JSON.stringify(["1", "0"]) })]
    expect(await fetchOfficialResolution(slotEndMs)).toBe("UP")
  })

  it("maps the winner by outcome LABEL, not positional index", async () => {
    // Outcomes listed in reverse order — label-based mapping must still win.
    fixture.closed = [
      gammaMarket({
        outcomes: JSON.stringify(["Down", "Up"]),
        outcomePrices: JSON.stringify(["0", "1"]),
      }),
    ]
    expect(await fetchOfficialResolution(slotEndMs)).toBe("UP")
  })

  it("returns null (never guesses) while the market is open and unresolved", async () => {
    fixture.open = [
      gammaMarket({ closed: false, umaResolutionStatus: "unresolved", outcomePrices: JSON.stringify(["0.52", "0.48"]) }),
    ]
    expect(await fetchOfficialResolution(slotEndMs)).toBeNull()
  })

  it("returns null for ambiguous post-close prices", async () => {
    fixture.closed = [gammaMarket({ outcomePrices: JSON.stringify(["0.5", "0.5"]) })]
    expect(await fetchOfficialResolution(slotEndMs)).toBeNull()
  })

  it("returns null when the market cannot be found at all", async () => {
    expect(await fetchOfficialResolution(slotEndMs)).toBeNull()
  })

  it("queries the slot-start-keyed slug (the market that was actually traded)", async () => {
    fixture.closed = [gammaMarket()]
    await fetchOfficialResolution(slotEndMs)
    const expectedSlug = slugForSlot(slotEndMs)
    expect(expectedSlug).toMatch(/^btc-updown-5m-\d+$/)
    // Slug must be keyed to the window START (end minus one 5-minute slot).
    expect(expectedSlug).toBe(`btc-updown-5m-${Math.round((slotEndMs - 300_000) / 1000)}`)
    expect(requestedUrls.some((u) => u.includes(encodeURIComponent(expectedSlug)))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. verifySettlements — the post-settlement integrity net
// ---------------------------------------------------------------------------

/** Insert a SETTLED trade backdated far enough to enter the verify window. */
function seedSettledTrade(opts: {
  uid: string
  marketId: string
  slotEndMs: number
  side: "UP" | "DOWN"
  result: "WIN" | "LOSS" | "SCRATCH"
  /** Override the booked PnL (e.g. to seed a correct-label-wrong-pnl row). */
  pnl?: number
  /** Extra explanation fields (e.g. resolutionSource for fallback seeds). */
  explanation?: Record<string, unknown>
}): number {
  const id = openTrade({
    marketId: opts.marketId,
    slotEndMs: opts.slotEndMs,
    side: opts.side,
    price: 0.55,
    shares: 20,
    cost: 11,
    balanceAfter: 89,
    mode: MODE,
    tradeUid: opts.uid,
  })
  const defaultPnl = opts.result === "WIN" ? 9 : opts.result === "SCRATCH" ? 0 : -11
  settleTrade({
    id,
    result: opts.result,
    pnl: opts.pnl ?? defaultPnl,
    balanceAfter: opts.result === "WIN" ? 109 : opts.result === "SCRATCH" ? 100 : 89,
    markPrice: opts.result === "WIN" ? 1 : opts.result === "SCRATCH" ? 0.55 : 0,
    explanation: JSON.stringify({ settlement: "test-seed", ...(opts.explanation ?? {}) }),
  })
  flushWriteQueueSync()
  // Backdate past MIN_AGE_MS (90s) so the verifier picks it up.
  const db = new Database(DB_FILE)
  db.prepare("UPDATE trades SET settled_at = datetime('now', '-10 minutes') WHERE trade_uid = ?").run(opts.uid)
  db.close()
  return id
}

describe("verifySettlements (post-settlement integrity net)", () => {
  const slotEndMs = 1_900_000_200_000

  it("verifies a correctly-settled trade and marks it permanently checked", async () => {
    const uid = `verify-ok-${Date.now()}`
    seedSettledTrade({ uid, marketId: `mkt-${uid}`, slotEndMs, side: "UP", result: "WIN" })
    fixture.closed = [gammaMarket({ outcomePrices: JSON.stringify(["1", "0"]) })] // official: UP

    const out = await verifySettlements(MODE)
    expect(out.mismatches).toBe(0)
    expect(out.verified).toBeGreaterThanOrEqual(1)
    expect(kvGet(`verify:settle:${uid}`)).toBe("ok")

    // Idempotency: a second sweep must skip the already-verified trade —
    // no additional Gamma lookups for OUR slot (other unverified trades in
    // the shared test DB may still be legitimately checked).
    const slug = slugForSlot(slotEndMs)
    const lookupsForOurSlot = () => requestedUrls.filter((u) => u.includes(encodeURIComponent(slug))).length
    const before = lookupsForOurSlot()
    await verifySettlements(MODE)
    expect(lookupsForOurSlot()).toBe(before)
    expect(kvGet(`verify:settle:${uid}`)).toBe("ok")
  })

  it("flags a mismatch as CRITICAL and applies an audited auto-repair (Phase 4)", async () => {
    const uid = `verify-bad-${Date.now()}`
    seedSettledTrade({ uid, marketId: `mkt-${uid}`, slotEndMs, side: "UP", result: "WIN" })
    fixture.closed = [gammaMarket({ outcomePrices: JSON.stringify(["0", "1"]) })] // official: DOWN — bet lost

    const out = await verifySettlements(MODE)
    expect(out.mismatches).toBe(1)
    expect(out.repairs).toBe(1)
    expect(kvGet(`verify:settle:${uid}`)).toBe("repaired:WIN->LOSS")
    flushWriteQueueSync()

    const db = new Database(DB_FILE, { readonly: true })
    // Audited auto-repair: the row is corrected WITH permanent evidence.
    const trade = db
      .prepare("SELECT result, pnl, explanation FROM trades WHERE trade_uid = ?")
      .get(uid) as { result: string; pnl: number; explanation: string }
    expect(trade.result).toBe("LOSS")
    expect(trade.pnl).toBeCloseTo(-11, 3) // payout 0 − cost 11
    expect(trade.explanation).toContain("settlementRepair")
    // The permanent CRITICAL mismatch row must still exist…
    const mismatchLog = db
      .prepare("SELECT detail FROM order_log WHERE detail LIKE ? AND detail LIKE '%SETTLEMENT_MISMATCH%' ORDER BY id DESC LIMIT 1")
      .get(`%${uid}%`) as { detail: string } | undefined
    // …alongside the permanent REPAIRED row.
    const repairLog = db
      .prepare("SELECT detail, event FROM order_log WHERE detail LIKE ? AND event = 'REPAIRED' ORDER BY id DESC LIMIT 1")
      .get(`%${uid}%`) as { detail: string; event: string } | undefined
    db.close()
    expect(mismatchLog?.detail).toContain("official_winner=DOWN")
    expect(repairLog?.detail).toContain("SETTLEMENT_REPAIRED")
    expect(repairLog?.detail).toContain("WIN→LOSS")
  })

  it("leaves pending trades unmarked and retries them on the next sweep", async () => {
    const uid = `verify-pending-${Date.now()}`
    seedSettledTrade({ uid, marketId: `mkt-${uid}`, slotEndMs, side: "DOWN", result: "LOSS" })
    // Resolution not yet published anywhere.
    fixture.open = []
    fixture.closed = []

    const out = await verifySettlements(MODE)
    expect(out.pending).toBeGreaterThanOrEqual(1)
    expect(kvGet(`verify:settle:${uid}`)).toBeNull()

    // Resolution arrives — the retry must now verify it.
    fixture.closed = [gammaMarket({ outcomePrices: JSON.stringify(["1", "0"]) })] // official UP; bet DOWN => LOSS correct
    const out2 = await verifySettlements(MODE)
    expect(out2.verified).toBeGreaterThanOrEqual(1)
    expect(kvGet(`verify:settle:${uid}`)).toBe("ok")
  })
})

// ---------------------------------------------------------------------------
// Phase 4 — settlement-repair engine (audited, atomic, idempotent)
// ---------------------------------------------------------------------------

function repairable(id: number, uid: string, over: Partial<RepairableTrade> = {}): RepairableTrade {
  return {
    id,
    tradeUid: uid,
    marketId: over.marketId ?? `mkt-${uid}`,
    slotEndMs: over.slotEndMs ?? 1_900_000_200_000,
    side: over.side ?? "UP",
    price: 0.55,
    shares: 20,
    cost: 11,
    result: over.result ?? "LOSS",
    pnl: over.pnl ?? -11,
    mode: MODE,
    ...over,
  }
}

describe("settlement-repair engine (Phase 4)", () => {
  const slotEndMs = 1_900_000_200_000
  const bankroll = new Bankroll(MODE)
  const poolTotal = () => bankroll.balance + bankroll.dustReserve

  it("computeExpected: WIN pays shares × $1, LOSS pays 0, PnL = payout − cost", () => {
    const up = computeExpected({ side: "UP", shares: 20, cost: 11 }, "UP")
    expect(up).toEqual({ result: "WIN", payout: 20, pnl: 9, markPrice: 1 })
    const down = computeExpected({ side: "UP", shares: 20, cost: 11 }, "DOWN")
    expect(down).toEqual({ result: "LOSS", payout: 0, pnl: -11, markPrice: 0 })
  })

  it("bookedPayout mirrors recordSettlement: WIN=shares, LOSS=0, SCRATCH=cost refund", () => {
    expect(bookedPayout({ result: "WIN", shares: 20, cost: 11 })).toBe(20)
    expect(bookedPayout({ result: "LOSS", shares: 20, cost: 11 })).toBe(0)
    expect(bookedPayout({ result: "SCRATCH", shares: 20, cost: 11 })).toBe(11)
  })

  it("repairs a wrong LOSS to WIN: credits the full payout delta + wallet mirror", () => {
    const uid = `verify-repair-losswin-${Date.now()}`
    const id = seedSettledTrade({ uid, marketId: `mkt-${uid}`, slotEndMs, side: "UP", result: "LOSS" })
    const before = poolTotal()
    const walletCredits: number[] = []

    const out = repairTrade(repairable(id, uid, { result: "LOSS", pnl: -11 }), "UP", {
      requestedBy: "test",
      creditWallet: (d) => walletCredits.push(d),
    })
    expect(out.applied).toBe(true)
    // Booked payout was 0 (LOSS); correct payout is 20 (WIN) → delta +20.
    expect(out.balanceDelta).toBeCloseTo(20, 4)
    expect(poolTotal()).toBeCloseTo(before + 20, 3)
    expect(walletCredits).toEqual([20])

    flushWriteQueueSync()
    const db = new Database(DB_FILE, { readonly: true })
    const row = db.prepare("SELECT result, pnl, mark_price, explanation FROM trades WHERE id = ?").get(id) as {
      result: string
      pnl: number
      mark_price: number
      explanation: string
    }
    db.close()
    expect(row.result).toBe("WIN")
    expect(row.pnl).toBeCloseTo(9, 3)
    expect(row.mark_price).toBe(1)
    const repair = (JSON.parse(row.explanation) as { settlementRepair: Record<string, unknown> }).settlementRepair
    expect(repair.officialWinner).toBe("UP")
    expect((repair.old as { result: string }).result).toBe("LOSS")
    expect((repair.new as { result: string }).result).toBe("WIN")
  })

  it("upgrades SCRATCH to WIN when the official result appears later (payout − refund delta)", () => {
    const uid = `verify-repair-scratchwin-${Date.now()}`
    const id = seedSettledTrade({ uid, marketId: `mkt-${uid}`, slotEndMs, side: "UP", result: "SCRATCH" })
    const before = poolTotal()

    const out = repairTrade(repairable(id, uid, { result: "SCRATCH", pnl: 0 }), "UP", { requestedBy: "test" })
    expect(out.applied).toBe(true)
    // SCRATCH already refunded cost ($11); WIN pays $20 → delta +9 (= the pnl).
    expect(out.balanceDelta).toBeCloseTo(9, 4)
    expect(poolTotal()).toBeCloseTo(before + 9, 3)

    flushWriteQueueSync()
    const db = new Database(DB_FILE, { readonly: true })
    const row = db.prepare("SELECT result, pnl FROM trades WHERE id = ?").get(id) as { result: string; pnl: number }
    db.close()
    expect(row.result).toBe("WIN")
    expect(row.pnl).toBeCloseTo(9, 3)
  })

  it("downgrades SCRATCH to LOSS when the official result went against the bet (claws back the refund)", () => {
    const uid = `verify-repair-scratchloss-${Date.now()}`
    const id = seedSettledTrade({ uid, marketId: `mkt-${uid}`, slotEndMs, side: "UP", result: "SCRATCH" })
    const before = poolTotal()

    const out = repairTrade(repairable(id, uid, { result: "SCRATCH", pnl: 0 }), "DOWN", { requestedBy: "test" })
    expect(out.applied).toBe(true)
    // SCRATCH refunded $11 that should never have come back → delta −11.
    expect(out.balanceDelta).toBeCloseTo(-11, 4)
    expect(poolTotal()).toBeCloseTo(before - 11, 3)

    flushWriteQueueSync()
    const db = new Database(DB_FILE, { readonly: true })
    const row = db.prepare("SELECT result, pnl FROM trades WHERE id = ?").get(id) as { result: string; pnl: number }
    db.close()
    expect(row.result).toBe("LOSS")
    expect(row.pnl).toBeCloseTo(-11, 3)
  })

  it("is idempotent: a second repair call is a no-op with zero balance movement", () => {
    const uid = `verify-repair-idem-${Date.now()}`
    const id = seedSettledTrade({ uid, marketId: `mkt-${uid}`, slotEndMs, side: "UP", result: "LOSS" })

    const first = repairTrade(repairable(id, uid, { result: "LOSS", pnl: -11 }), "UP", { requestedBy: "test" })
    expect(first.applied).toBe(true)
    const afterFirst = poolTotal()

    // Second call — even with the (stale) original trade fields.
    const second = repairTrade(repairable(id, uid, { result: "LOSS", pnl: -11 }), "UP", { requestedBy: "test" })
    expect(second.applied).toBe(false)
    expect(second.reason).toContain("already repaired")
    expect(second.balanceDelta).toBe(0)
    expect(poolTotal()).toBeCloseTo(afterFirst, 4)
  })

  it("refuses to repair a trade whose booked settlement already matches the official result", () => {
    const uid = `verify-repair-match-${Date.now()}`
    const id = seedSettledTrade({ uid, marketId: `mkt-${uid}`, slotEndMs, side: "UP", result: "WIN" })
    const before = poolTotal()
    const out = repairTrade(repairable(id, uid, { result: "WIN", pnl: 9 }), "UP", { requestedBy: "test" })
    expect(out.applied).toBe(false)
    expect(out.reason).toContain("already matches")
    expect(poolTotal()).toBeCloseTo(before, 4)
  })

  it("verifier auto-repairs a wrong-PnL trade even when the result label is correct", async () => {
    const uid = `verify-badpnl-${Date.now()}`
    // Correct label (WIN) but corrupted PnL (+2 instead of +9).
    seedSettledTrade({ uid, marketId: `mkt-${uid}`, slotEndMs, side: "UP", result: "WIN", pnl: 2 })
    fixture.closed = [gammaMarket({ outcomePrices: JSON.stringify(["1", "0"]) })] // official: UP

    const out = await verifySettlements(MODE)
    expect(out.mismatches).toBe(1)
    expect(out.repairs).toBe(1)

    flushWriteQueueSync()
    const db = new Database(DB_FILE, { readonly: true })
    const row = db.prepare("SELECT result, pnl FROM trades WHERE trade_uid = ?").get(uid) as { result: string; pnl: number }
    db.close()
    expect(row.result).toBe("WIN")
    expect(row.pnl).toBeCloseTo(9, 3)
  })

  it("verifier upgrades a spot-fallback-settled SCRATCH/mismatch with priority ordering", async () => {
    const goodUid = `verify-prio-good-${Date.now()}`
    const softUid = `verify-prio-soft-${Date.now()}`
    // A hard-settled correct trade AND a soft (spot-fallback) wrong trade in
    // the same sweep; the soft one must be checked (priority) despite sharing
    // the lookup budget.
    seedSettledTrade({ uid: goodUid, marketId: `mkt-${goodUid}`, slotEndMs, side: "UP", result: "WIN", explanation: { resolutionSource: "official" } })
    seedSettledTrade({ uid: softUid, marketId: `mkt-${softUid}`, slotEndMs, side: "DOWN", result: "WIN", explanation: { resolutionSource: "spot-fallback" }, pnl: 9 })
    fixture.closed = [gammaMarket({ outcomePrices: JSON.stringify(["1", "0"]) })] // official: UP → soft trade (bet DOWN) is a LOSS

    const out = await verifySettlements(MODE)
    expect(out.repairs).toBeGreaterThanOrEqual(1)
    expect(kvGet(`verify:settle:${softUid}`)).toBe("repaired:WIN->LOSS")

    flushWriteQueueSync()
    const db = new Database(DB_FILE, { readonly: true })
    const row = db.prepare("SELECT result, pnl FROM trades WHERE trade_uid = ?").get(softUid) as { result: string; pnl: number }
    db.close()
    expect(row.result).toBe("LOSS")
    expect(row.pnl).toBeCloseTo(-11, 3)
  })

  it("balance-chain audit reports breaks without rewriting anything (report-only)", async () => {
    // Two chained trades where the second's stamped balance ignores its PnL.
    const uidA = `verify-chain-a-${Date.now()}`
    const uidB = `verify-chain-b-${Date.now()}`
    const idA = seedSettledTrade({ uid: uidA, marketId: `mkt-${uidA}`, slotEndMs, side: "UP", result: "WIN" })
    const idB = seedSettledTrade({ uid: uidB, marketId: `mkt-${uidB}`, slotEndMs, side: "UP", result: "LOSS" })
    flushWriteQueueSync()
    const db = new Database(DB_FILE)
    // Chain: A ends at $100; B books PnL −11 but its stamp says $150 (break).
    db.prepare("UPDATE trades SET balance_after = 100 WHERE id = ?").run(idA)
    db.prepare("UPDATE trades SET balance_after = 150 WHERE id = ?").run(idB)
    db.close()
    // No resolutions published — sweep runs only the balance-chain audit.
    fixture.open = []
    fixture.closed = []

    const out = await verifySettlements(MODE)
    expect(out.balanceChainBreaks).toBeGreaterThanOrEqual(1)

    // Report-only: the rows must be untouched.
    const db2 = new Database(DB_FILE, { readonly: true })
    const b = db2.prepare("SELECT balance_after, result FROM trades WHERE id = ?").get(idB) as { balance_after: number; result: string }
    db2.close()
    expect(b.balance_after).toBe(150)
    expect(b.result).toBe("LOSS")
  })

  // ---------------------------------------------------------------------------
  // Bug #004b — Post-repair PnL / explanation mismatch on the compounding ledger
  //
  // Before the fix, `repairTrade` rewrote result/pnl/mark_price but left the
  // ledger's human-readable settlement/pnlCalc/resolvedWinner/resolutionSource
  // fields frozen at the initial booking. The ledger UI then showed
  // contradictions like "LOSS -$9.00" next to "SCRATCH — cost refunded;
  // realized PnL $0.0000", making correctly-repaired WINs read like losses.
  // ---------------------------------------------------------------------------
  it("Bug #004b: repair overwrites human-readable settlement/pnlCalc so the ledger tells a coherent story (SCRATCH → WIN)", () => {
    const uid = `verify-repair-explanation-scratchwin-${Date.now()}`
    const id = seedSettledTrade({
      uid,
      marketId: `mkt-${uid}`,
      slotEndMs,
      side: "UP",
      result: "SCRATCH",
      explanation: {
        settlement: "SCRATCH — no reliable market resolution (source: scratch); the entry cost was refunded so the slot nets exactly zero",
        pnlCalc: "cost $11.0000 refunded; realized PnL $0.0000",
        resolvedWinner: null,
        resolutionSource: "scratch",
      },
    })

    const out = repairTrade(repairable(id, uid, { result: "SCRATCH", pnl: 0 }), "UP", { requestedBy: "test-004b" })
    expect(out.applied).toBe(true)

    flushWriteQueueSync()
    const db = new Database(DB_FILE, { readonly: true })
    const row = db.prepare("SELECT result, pnl, explanation FROM trades WHERE id = ?").get(id) as {
      result: string
      pnl: number
      explanation: string
    }
    db.close()

    expect(row.result).toBe("WIN")
    expect(row.pnl).toBeCloseTo(9, 3)

    const parsed = JSON.parse(row.explanation) as {
      settlement: string
      pnlCalc: string
      resolvedWinner: string | null
      resolutionSource: string
      settlementRepair: { old: { result: string; pnl: number } }
    }
    // Human-readable settlement fields now match the repaired outcome — no
    // more SCRATCH/refund text on a WIN row.
    expect(parsed.settlement).toMatch(/^WIN /)
    expect(parsed.settlement).not.toMatch(/SCRATCH/)
    expect(parsed.settlement).not.toMatch(/refunded/)
    expect(parsed.pnlCalc).toMatch(/payout \$20\.0000/)
    expect(parsed.pnlCalc).toMatch(/\+\$9\.0000/)
    expect(parsed.pnlCalc).not.toMatch(/refunded/)
    expect(parsed.resolvedWinner).toBe("UP")
    expect(parsed.resolutionSource).toBe("settlement-repair")
    // Original booking is preserved forever for the audit trail.
    expect(parsed.settlementRepair.old.result).toBe("SCRATCH")
    expect(parsed.settlementRepair.old.pnl).toBe(0)
  })

  it("Bug #004b: repair overwrites human-readable settlement/pnlCalc when downgrading SCRATCH → LOSS", () => {
    const uid = `verify-repair-explanation-scratchloss-${Date.now()}`
    const id = seedSettledTrade({
      uid,
      marketId: `mkt-${uid}`,
      slotEndMs,
      side: "UP",
      result: "SCRATCH",
      explanation: {
        settlement: "SCRATCH — no reliable market resolution (source: scratch); the entry cost was refunded so the slot nets exactly zero",
        pnlCalc: "cost $11.0000 refunded; realized PnL $0.0000",
        resolvedWinner: null,
        resolutionSource: "scratch",
      },
    })

    const out = repairTrade(repairable(id, uid, { result: "SCRATCH", pnl: 0 }), "DOWN", { requestedBy: "test-004b" })
    expect(out.applied).toBe(true)

    flushWriteQueueSync()
    const db = new Database(DB_FILE, { readonly: true })
    const row = db.prepare("SELECT result, explanation FROM trades WHERE id = ?").get(id) as {
      result: string
      explanation: string
    }
    db.close()

    expect(row.result).toBe("LOSS")
    const parsed = JSON.parse(row.explanation) as {
      settlement: string
      pnlCalc: string
      resolvedWinner: string
      resolutionSource: string
    }
    expect(parsed.settlement).toMatch(/^LOSS /)
    expect(parsed.settlement).not.toMatch(/SCRATCH/)
    expect(parsed.pnlCalc).toMatch(/-\$11\.0000/)
    expect(parsed.resolvedWinner).toBe("DOWN")
    expect(parsed.resolutionSource).toBe("settlement-repair")
  })
})

