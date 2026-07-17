/**
 * OPS-LAYER CHAOS — Phase 5 operations infrastructure under failure injection.
 *
 * The trading engine has its own chaos suites (feed-chaos, db-chaos). This
 * suite attacks the NEW operations layer:
 *   • notifier: Telegram total outage, timeouts, garbage prefs in KV
 *   • redaction: secrets can never leave the process
 *   • analytics: empty ledger, single-trade ledger, all-scratch ledger
 *   • audit log: filter injection attempts, absurd limits
 *
 * Invariant under test: NOTHING in the ops layer may ever throw into a caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

const TEST_DB = "data/test-ops-chaos.db"

beforeEach(() => {
  process.env.DB_PATH = TEST_DB
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(path.resolve(process.cwd(), `${TEST_DB}${suffix}`))
    } catch {
      /* absent */
    }
  }
})

describe("notifier under Telegram chaos", () => {
  it("notify() never throws when fetch rejects (Telegram total outage)", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token")
    vi.stubEnv("TELEGRAM_CHAT_ID", "12345")
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
    const { notify } = await import("@/lib/v2/engine/notifier")
    expect(() => notify("errors", "TEST", "outage drill")).not.toThrow()
    // Let the rejected promise settle — an unhandled rejection would fail the run.
    await new Promise((r) => setTimeout(r, 20))
  })

  it("notify() never throws when fetch itself throws synchronously", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token")
    vi.stubEnv("TELEGRAM_CHAT_ID", "12345")
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("synchronous fetch explosion")
    })
    const { notify } = await import("@/lib/v2/engine/notifier")
    expect(() => notify("risk", "TEST", "sync throw drill")).not.toThrow()
  })

  it("notify() is a silent no-op when Telegram is not configured", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "")
    vi.stubEnv("TELEGRAM_CHAT_ID", "")
    const spy = vi.spyOn(globalThis, "fetch")
    const { notify } = await import("@/lib/v2/engine/notifier")
    notify("lifecycle", "SHOULD NOT SEND")
    expect(spy).not.toHaveBeenCalled()
  })

  it("secrets are redacted before leaving the process", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token")
    vi.stubEnv("TELEGRAM_CHAT_ID", "12345")
    let sentBody = ""
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sentBody = String((init as RequestInit).body)
      return new Response("{}", { status: 200 })
    })
    const { notify } = await import("@/lib/v2/engine/notifier")
    notify(
      "errors",
      "LEAK DRILL",
      "wallet 0xabcdef0123456789abcdef0123456789abcdef0123456789 failed with api_key=super-secret-value",
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(sentBody).not.toContain("0xabcdef0123456789")
    expect(sentBody).not.toContain("super-secret-value")
    expect(sentBody).toContain("[redacted-key]")
    expect(sentBody).toContain("api_key=[redacted]")
  })

  it("category cooldown suppresses a flapping risk alert", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token")
    vi.stubEnv("TELEGRAM_CHAT_ID", "12345")
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    const { notify } = await import("@/lib/v2/engine/notifier")
    for (let i = 0; i < 25; i++) notify("risk", "FLAPPING BREAKER", `attempt ${i}`)
    await new Promise((r) => setTimeout(r, 20))
    expect(spy.mock.calls.length).toBe(1)
  })

  it("garbage JSON in the prefs KV never breaks reads or writes", async () => {
    const { kvSet } = await import("@/lib/v2/engine/db")
    kvSet("notify:prefs:v1", "{{{{not json")
    const { getNotifyPrefs, setNotifyPrefs } = await import("@/lib/v2/engine/notifier")
    const prefs = getNotifyPrefs()
    expect(prefs.errors).toBe(true) // fell back to defaults
    const next = setNotifyPrefs({ market: true })
    expect(next.market).toBe(true)
    expect(getNotifyPrefs().market).toBe(true) // repaired and persisted
  })
})

describe("analytics under degenerate ledgers", () => {
  it("empty ledger produces a complete, all-zero summary (no NaN, no throw)", async () => {
    const { computeAnalytics } = await import("@/lib/v2/engine/analytics")
    const s = computeAnalytics("PAPER_V1")
    expect(s.totalTrades).toBe(0)
    expect(Number.isFinite(s.winRate)).toBe(true)
    // Nullable-by-design fields must be null (not NaN) on an empty ledger.
    expect(s.maxDrawdownPct).toBeNull()
    expect(s.roiPct).toBeNull()
    expect(s.profitFactor).toBe(0)
    expect(s.dailyPnl.length).toBe(0)
    expect(s.bankrollSeries.length).toBe(0)
  })

  it("all-scratch ledger yields 0% win rate without division blowups", async () => {
    const { insertTrade } = await import("@/lib/v2/engine/db")
    for (let i = 0; i < 5; i++) {
      insertTrade({
        mode: "PAPER_V1",
        marketId: `scratch-${i}`,
        slotEndMs: Date.now(),
        side: "UP",
        price: 0.9,
        shares: 10,
        cost: 9,
        result: "SCRATCH",
        pnl: 0,
        balanceAfter: 100,
        dustSaved: 0,
      })
    }
    const { computeAnalytics } = await import("@/lib/v2/engine/analytics")
    const s = computeAnalytics("PAPER_V1")
    expect(s.totalTrades).toBe(5)
    expect(s.winRate).toBe(0)
    expect(s.scratches).toBe(5)
    expect(s.profitFactor).toBe(0)
    expect(Number.isFinite(s.avgTradeUsd)).toBe(true)
  })
})

describe("audit log under hostile inputs", () => {
  it("SQL-injection-shaped search terms are treated as literals", async () => {
    const { insertAuditLog, queryAuditLog } = await import("@/lib/v2/engine/db")
    insertAuditLog("info", "system", "benign row")
    const hostile = queryAuditLog({ search: "'; DROP TABLE audit_log; --" })
    expect(hostile.length).toBe(0) // no match — and the table survived:
    expect(queryAuditLog({}).length).toBe(1)
  })

  it("absurd limits are clamped instead of honored", async () => {
    const { insertAuditLog, queryAuditLog } = await import("@/lib/v2/engine/db")
    for (let i = 0; i < 10; i++) insertAuditLog("info", "system", `row ${i}`)
    expect(queryAuditLog({ limit: 999_999 }).length).toBe(10)
    expect(queryAuditLog({ limit: -5 }).length).toBe(1) // clamped to 1
  })
})
