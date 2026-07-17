import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { buildTradeReplay, deriveVerdict, type FeedAuditRecord, type TradeRow } from "../../lib/v2/engine/trade-replay"

// ------------------------------------------------------------------
// Direction-verdict tests: the forensic replay builder must reach the
// correct conclusion from stored evidence — CORRECT for right-side
// entries, WRONG_SIDE when the stored snapshot contradicts the entry,
// and UNPROVABLE (never guessing) when evidence is missing.
// ------------------------------------------------------------------

const SLOT_END = 1_752_450_000_000

function makeTrade(overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    id: 202,
    market_id: "btc-updown-5m-test",
    slot_end_ms: SLOT_END,
    side: "DOWN",
    price: 0.6,
    shares: 10,
    cost: 6,
    result: "LOSS",
    pnl: -6,
    balance_after: 94,
    mode: "PAPER_V1",
    created_at: "2026-07-14 05:20:00",
    settled_at: "2026-07-14 05:25:00",
    status: "SETTLED",
    order_id: null,
    trade_uid: null,
    entry_at_ms: SLOT_END - 240_000,
    mark_price: 0,
    explanation: null,
    ...overrides,
  }
}

function makeFeedAudit(overrides: Partial<FeedAuditRecord> = {}): FeedAuditRecord {
  return {
    generation: 7,
    sequence: 1234,
    snapshotAtMs: SLOT_END - 240_500,
    triggerPrice: 0.6,
    triggerMode: "AT_OR_ABOVE",
    limitPrice: 0.55,
    winningSide: "DOWN",
    majority: { side: "DOWN", upPct: 40, downPct: 60 },
    quotes: {
      up: { price: 0.4, source: "WS", ageMs: 120, latencyMs: 45 },
      down: { price: 0.6, source: "WS", ageMs: 110, latencyMs: 45 },
    },
    wsFreshMs: 110,
    restFreshMs: 900,
    confidence: "HIGH",
    marketId: "btc-updown-5m-test",
    slotEndMs: SLOT_END,
    lock: {
      generation: 7,
      marketId: "btc-updown-5m-test",
      upTokenId: "up-tok",
      downTokenId: "down-tok",
      lockedAtMs: SLOT_END - 240_400,
    },
    ...overrides,
  }
}

describe("deriveVerdict — post-Phase-1 trades (feedAudit present)", () => {
  it("CORRECT under majority-only policy: entered side matches BTC-reference direction and reached trigger", () => {
    const trade = makeTrade({ side: "UP" })
    const audit = makeFeedAudit({
      sideSelectionBasis: "BTC_REFERENCE_MAJORITY",
      winningSide: "UP",
      btcReference: { strike: 64_410.5, spot: 64_435, direction: "UP", spotAgeMs: 120 },
      majority: { side: "UP", upPct: 92, downPct: 8 },
      quotes: {
        up: { price: 0.92, source: "WS", ageMs: 120, latencyMs: 45 },
        down: { price: 0.08, source: "WS", ageMs: 110, latencyMs: 45 },
      },
    })
    const v = deriveVerdict(trade, { feedAudit: audit }, audit, [])
    expect(v.conclusion).toBe("CORRECT")
    expect(v.findings.join(" ")).toContain("BTC-reference majority")
  })

  it("WRONG_SIDE under majority-only policy: minority contract reached trigger but BTC-reference direction was opposite", () => {
    const trade = makeTrade({ side: "DOWN" })
    const audit = makeFeedAudit({
      sideSelectionBasis: "BTC_REFERENCE_MAJORITY",
      winningSide: "DOWN",
      btcReference: { strike: 64_410.5, spot: 64_435, direction: "UP", spotAgeMs: 120 },
      majority: { side: "UP", upPct: 50, downPct: 94 },
      quotes: {
        up: { price: 0.5, source: "WS", ageMs: 120, latencyMs: 45 },
        down: { price: 0.94, source: "WS", ageMs: 110, latencyMs: 45 },
      },
    })
    const v = deriveVerdict(trade, { feedAudit: audit }, audit, [])
    expect(v.conclusion).toBe("WRONG_SIDE")
    expect(v.findings.join(" ")).toContain("BTC-reference majority was UP")
  })

  it("CORRECT: entered side was the only one at trigger in the firing snapshot", () => {
    const trade = makeTrade({ side: "DOWN" })
    const audit = makeFeedAudit() // DOWN 0.60 >= trigger 0.60; UP 0.40 below
    const v = deriveVerdict(trade, { feedAudit: audit }, audit, [])
    expect(v.conclusion).toBe("CORRECT")
    expect(v.missingEvidence).toHaveLength(0)
  })

  it("WRONG_SIDE: entered side had NOT reached the trigger while the opposite HAD", () => {
    // The reported failure shape: entered DOWN but the stored snapshot shows
    // UP was the side at trigger.
    const trade = makeTrade({ side: "DOWN" })
    const audit = makeFeedAudit({
      quotes: {
        up: { price: 0.62, source: "WS", ageMs: 120, latencyMs: 45 },
        down: { price: 0.38, source: "WS", ageMs: 110, latencyMs: 45 },
      },
      majority: { side: "UP", upPct: 62, downPct: 38 },
    })
    const v = deriveVerdict(trade, { feedAudit: audit }, audit, [])
    expect(v.conclusion).toBe("WRONG_SIDE")
    expect(v.findings.join(" ")).toContain("WRONG SIDE")
  })

  it("both-at-trigger resolves by higher ask: entered side higher → CORRECT", () => {
    const trade = makeTrade({ side: "DOWN" })
    const audit = makeFeedAudit({
      quotes: {
        up: { price: 0.6, source: "WS", ageMs: 120, latencyMs: 45 },
        down: { price: 0.63, source: "REST", ageMs: 300, latencyMs: 80 },
      },
    })
    const v = deriveVerdict(trade, { feedAudit: audit }, audit, [])
    expect(v.conclusion).toBe("CORRECT")
  })

  it("both-at-trigger resolves by higher ask: opposite side higher → WRONG_SIDE", () => {
    const trade = makeTrade({ side: "DOWN" })
    const audit = makeFeedAudit({
      quotes: {
        up: { price: 0.7, source: "WS", ageMs: 120, latencyMs: 45 },
        down: { price: 0.61, source: "WS", ageMs: 110, latencyMs: 45 },
      },
    })
    const v = deriveVerdict(trade, { feedAudit: audit }, audit, [])
    expect(v.conclusion).toBe("WRONG_SIDE")
  })
})

describe("deriveVerdict — pre-Phase-1 trades (no feedAudit)", () => {
  it("UNPROVABLE with explicit missing-evidence list; never guesses", () => {
    const trade = makeTrade({
      explanation: JSON.stringify({
        entry: "standing limit order: DOWN won the race to trigger $0.60",
        sideSelection: "direction locked to DOWN — first side whose best-ask reached the trigger",
      }),
    })
    const v = deriveVerdict(
      trade,
      JSON.parse(trade.explanation!) as Record<string, unknown>,
      null,
      [],
    )
    expect(v.conclusion).toBe("UNPROVABLE")
    expect(v.missingEvidence.some((m) => m.includes("feedAudit"))).toBe(true)
    // The stored narrative must still be surfaced as findings.
    expect(v.findings.join(" ")).toContain("direction locked to DOWN")
  })
})

describe("buildTradeReplay — end-to-end over a synthetic ledger", () => {
  function makeSyntheticDb(): Database.Database {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT, market_id TEXT NOT NULL, slot_end_ms INTEGER NOT NULL,
        side TEXT NOT NULL, price REAL NOT NULL, shares INTEGER NOT NULL, cost REAL NOT NULL,
        result TEXT NOT NULL, pnl REAL NOT NULL, balance_after REAL NOT NULL, dust_saved REAL NOT NULL DEFAULT 0,
        mode TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), settled_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT, order_id TEXT, trade_uid TEXT, entry_at_ms INTEGER, mark_price REAL, unrealized_pnl REAL, explanation TEXT
      );
      CREATE TABLE order_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, mode TEXT NOT NULL, event TEXT NOT NULL,
        market_id TEXT NOT NULL, token_id TEXT, exchange_order_id TEXT, side TEXT, price REAL, shares INTEGER,
        phase TEXT, detail TEXT
      );
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, level TEXT NOT NULL,
        category TEXT NOT NULL, message TEXT NOT NULL
      );
    `)
    return db
  }

  it("assembles trade + order log + siblings and reaches CORRECT", () => {
    const db = makeSyntheticDb()
    const audit = makeFeedAudit()
    const insertTrade = db.prepare(
      `INSERT INTO trades (market_id, slot_end_ms, side, price, shares, cost, result, pnl, balance_after, mode, status, entry_at_ms, explanation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SETTLED', ?, ?)`,
    )
    insertTrade.run(
      "btc-updown-5m-test", SLOT_END, "DOWN", 0.6, 10, 6, "LOSS", -6, 94, "PAPER_V1", SLOT_END - 240_000,
      JSON.stringify({ entry: "standing limit", feedAudit: audit }),
    )
    insertTrade.run(
      "btc-updown-5m-test", SLOT_END, "UP", 0.4, 5, 2, "WIN", 3, 97, "PAPER_V1", SLOT_END - 200_000,
      null,
    )
    db.prepare(
      `INSERT INTO order_log (ts_ms, mode, event, market_id, side, price, shares, phase, detail)
       VALUES (?, 'PAPER_V1', 'SUBMITTED', 'btc-updown-5m-test', 'DOWN', 0.55, 10, 'WAITING', 'trigger reached')`,
    ).run(SLOT_END - 240_500)
    db.prepare(
      `INSERT INTO order_log (ts_ms, mode, event, market_id, side, price, shares, phase, detail)
       VALUES (?, 'PAPER_V1', 'FILLED', 'btc-updown-5m-test', 'DOWN', 0.6, 10, 'FILLED', 'maker fill')`,
    ).run(SLOT_END - 238_000)

    const bundle = buildTradeReplay(db, 1)
    expect(bundle.trade.id).toBe(1)
    expect(bundle.feedAudit).not.toBeNull()
    expect(bundle.orderLog.length).toBe(2)
    expect(bundle.siblingTrades.length).toBe(1)
    expect(bundle.siblingTrades[0].id).toBe(2)
    expect(bundle.verdict.conclusion).toBe("CORRECT")
    db.close()
  })

  it("throws a clear error (with id range) for a missing trade id", () => {
    const db = makeSyntheticDb()
    expect(() => buildTradeReplay(db, 999)).toThrow(/not found/)
    db.close()
  })

  it("pre-Phase-1 trade in a real ledger shape → UNPROVABLE with missing evidence", () => {
    const db = makeSyntheticDb()
    db.prepare(
      `INSERT INTO trades (market_id, slot_end_ms, side, price, shares, cost, result, pnl, balance_after, mode, status, entry_at_ms, explanation)
       VALUES ('btc-updown-5m-old', ?, 'DOWN', 0.61, 8, 4.88, 'LOSS', -4.88, 89, 'PAPER_V1', 'SETTLED', ?, ?)`,
    ).run(SLOT_END, SLOT_END - 230_000, JSON.stringify({ entry: "standing limit order: DOWN won the race" }))
    const bundle = buildTradeReplay(db, 1)
    expect(bundle.feedAudit).toBeNull()
    expect(bundle.verdict.conclusion).toBe("UNPROVABLE")
    expect(bundle.verdict.missingEvidence.length).toBeGreaterThan(0)
    db.close()
  })
})
