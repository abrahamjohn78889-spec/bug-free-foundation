/**
 * PHASE 6 REGRESSION — strategy profiles, A/B comparison, Telegram console.
 *
 * Invariants under test:
 *   • Profile CRUD round-trips every configurable option exactly.
 *   • loadProfile NEVER starts the engine and REFUSES while running.
 *   • Comparison is read-only and never divides by zero / NaNs.
 *   • Telegram console rejects unauthorized chats and audit-logs control
 *     commands; read commands never mutate engine state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

const TEST_DB = "data/test-profiles.db"

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

/** Minimal engine double exposing exactly the seams profiles use. */
function makeEngineDouble(running = false) {
  const calls: string[] = []
  const state = {
    running,
    mode: "PAPER_V1" as const,
    started: false,
  }
  const engine = {
    snapshot: () => ({
      running: state.running,
      mode: state.mode,
      config: {
        p1Band: { min: 0.8, max: 0.99 },
        p2Band: { min: 0.85, max: 0.99 },
        driftPaddingUsd: 25,
        tif: "GTC",
        p1WindowMs: 60_000,
        priceFloor: 0.5,
        priceCeil: 0.99,
        activeStrategy: "edge5",
        strategyParams: { edge5: { freezeEnabled: true } },
      },
      standingLimitOrder: {
        limitPrice: 0.92,
        triggerPrice: 0.9,
        triggerMode: "AT_OR_ABOVE",
        minPrice: 0.01,
        maxPrice: 0.99,
        sizingMode: "FIXED_SHARES",
        sizeValue: 10,
        entryWindowMs: 30_000,
      },
      risk: {
        limits: { maxDailyLossUsd: 50, maxOrderNotionalUsd: 100, maxDailyOrders: 20, maxSharesPerOrder: 100 },
        killSwitch: { engaged: false, reason: "", source: "" },
      },
      balance: 100,
      dustReserve: 0,
    }),
    setMode: (m: string) => calls.push(`setMode:${m}`),
    setBands: () => calls.push("setBands"),
    setDriftPadding: () => calls.push("setDriftPadding"),
    setTif: () => calls.push("setTif"),
    setP1Window: () => calls.push("setP1Window"),
    setPriceRange: () => calls.push("setPriceRange"),
    setStrategy: (s: string | null) => calls.push(`setStrategy:${s}`),
    setStrategyParams: () => calls.push("setStrategyParams"),
    setLimitOrder: () => calls.push("setLimitOrder"),
    clearLimitOrder: () => calls.push("clearLimitOrder"),
    setRiskLimits: () => calls.push("setRiskLimits"),
    start: () => {
      state.started = true
      calls.push("start")
      return "started"
    },
  }
  return { engine: engine as never, calls, state }
}

describe("strategy profile CRUD", () => {
  it("create → get round-trips the full config including SLO and risk limits", async () => {
    const p = await import("@/lib/v2/engine/strategy-profiles")
    const { engine } = makeEngineDouble()
    const cfg = p.captureCurrentConfig(engine)
    p.createProfile("Conservative", cfg, "small size")

    const loaded = p.getProfile("Conservative")!
    expect(loaded.name).toBe("Conservative")
    expect(loaded.notes).toBe("small size")
    expect(loaded.config.slo?.triggerPrice).toBe(0.9)
    expect(loaded.config.slo?.entryWindowSec).toBe(30)
    expect(loaded.config.riskLimits.maxDailyLossUsd).toBe(50)
    expect(loaded.config.activeStrategy).toBe("edge5")
    expect(loaded.config.strategyParams.edge5).toEqual({ freezeEnabled: true })
  })

  it("rejects duplicate names, blank names, and names over 60 chars", async () => {
    const p = await import("@/lib/v2/engine/strategy-profiles")
    const { engine } = makeEngineDouble()
    const cfg = p.captureCurrentConfig(engine)
    p.createProfile("A", cfg)
    expect(() => p.createProfile("A", cfg)).toThrow(/already exists/)
    expect(() => p.createProfile("   ", cfg)).toThrow(/required/)
    expect(() => p.createProfile("x".repeat(61), cfg)).toThrow(/60 characters/)
  })

  it("rename keeps session attribution and active-profile pointer intact", async () => {
    const p = await import("@/lib/v2/engine/strategy-profiles")
    const { engine } = makeEngineDouble()
    p.createProfile("Old", p.captureCurrentConfig(engine))
    p.loadProfile(engine, "Old")
    expect(p.getActiveProfileName()).toBe("Old")
    p.renameProfile("Old", "New")
    expect(p.getActiveProfileName()).toBe("New")
    expect(p.getProfileSessions("New").length).toBe(1)
    expect(p.getProfileSessions("Old").length).toBe(0)
  })

  it("duplicate copies config; delete clears the active pointer", async () => {
    const p = await import("@/lib/v2/engine/strategy-profiles")
    const { engine } = makeEngineDouble()
    p.createProfile("Src", p.captureCurrentConfig(engine), "notes here")
    const dup = p.duplicateProfile("Src", "Copy")
    expect(dup.config.slo?.limitPrice).toBe(0.92)
    expect(dup.notes).toBe("notes here")
    p.loadProfile(engine, "Copy")
    p.deleteProfile("Copy")
    expect(p.getActiveProfileName()).toBeNull()
    expect(p.getProfile("Copy")).toBeNull()
  })
})

describe("profile loading safety", () => {
  it("loadProfile NEVER calls engine.start()", async () => {
    const p = await import("@/lib/v2/engine/strategy-profiles")
    const { engine, calls, state } = makeEngineDouble()
    p.createProfile("Safe", p.captureCurrentConfig(engine))
    const res = p.loadProfile(engine, "Safe")
    expect(res.ok).toBe(true)
    expect(res.message).toContain("NOT started")
    expect(calls).not.toContain("start")
    expect(state.started).toBe(false)
  })

  it("REFUSES to apply while the engine is running", async () => {
    const p = await import("@/lib/v2/engine/strategy-profiles")
    const stopped = makeEngineDouble(false)
    p.createProfile("Blocked", p.captureCurrentConfig(stopped.engine))
    const running = makeEngineDouble(true)
    const res = p.loadProfile(running.engine, "Blocked")
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/RUNNING/i)
    // No setter may have been touched.
    expect(running.calls.length).toBe(0)
  })

  it("loading opens a new session and closes the previous one", async () => {
    const p = await import("@/lib/v2/engine/strategy-profiles")
    const { engine } = makeEngineDouble()
    p.createProfile("S1", p.captureCurrentConfig(engine))
    p.createProfile("S2", p.captureCurrentConfig(engine))
    p.loadProfile(engine, "S1")
    p.loadProfile(engine, "S2")
    const s1 = p.getProfileSessions("S1")
    const s2 = p.getProfileSessions("S2")
    expect(s1.length).toBe(1)
    expect(s1[0].endMs).not.toBeNull() // closed when S2 loaded
    expect(s2.length).toBe(1)
    expect(s2[0].endMs).toBeNull() // still open
  })
})

describe("A/B comparison (read-only)", () => {
  it("attributes trades to profiles by session window and computes stats", async () => {
    const p = await import("@/lib/v2/engine/strategy-profiles")
    const { insertTrade } = await import("@/lib/v2/engine/db")
    const { engine } = makeEngineDouble()
    p.createProfile("Alpha", p.captureCurrentConfig(engine))
    p.createProfile("Beta", p.captureCurrentConfig(engine))

    // Session for Alpha, then trades, then switch to Beta, then trades.
    p.loadProfile(engine, "Alpha")
    for (let i = 0; i < 4; i++) {
      insertTrade({
        mode: "PAPER_V1",
        marketId: `alpha-${i}`,
        slotEndMs: Date.now(),
        side: "UP",
        price: 0.9,
        shares: 10,
        cost: 9,
        result: i === 0 ? "LOSS" : "WIN", // 3W 1L
        pnl: i === 0 ? -9 : 1,
        balanceAfter: 100 + i,
        dustSaved: 0,
      })
    }
    // created_at has second granularity — separate the sessions by more than
    // one full second so attribution is unambiguous, as it is in real use
    // where sessions span hours.
    await new Promise((r) => setTimeout(r, 1_100))
    p.loadProfile(engine, "Beta")
    // Clear Alpha's ceiled end-second before Beta's trades so they attribute
    // to Beta alone.
    await new Promise((r) => setTimeout(r, 2_100))
    for (let i = 0; i < 2; i++) {
      insertTrade({
        mode: "PAPER_V1",
        marketId: `beta-${i}`,
        slotEndMs: Date.now(),
        side: "DOWN",
        price: 0.85,
        shares: 10,
        cost: 8.5,
        result: "LOSS", // 0W 2L
        pnl: -8.5,
        balanceAfter: 90 - i,
        dustSaved: 0,
      })
    }

    const { compareProfiles } = await import("@/lib/v2/engine/comparison")
    const result = compareProfiles("Alpha", "Beta")
    expect(result.a.totalTrades).toBe(4)
    expect(result.a.wins).toBe(3)
    expect(result.b.totalTrades).toBe(2)
    expect(result.b.losses).toBe(2)
    expect(result.winners.winRate).toBe("a")
    expect(result.recommendation).toContain("no strategy has been changed")
  })

  it("handles unknown profiles and empty sessions without NaN", async () => {
    const { compareProfiles } = await import("@/lib/v2/engine/comparison")
    const r = compareProfiles("ghost-a", "ghost-b")
    expect(r.a.found).toBe(false)
    expect(r.b.found).toBe(false)
    expect(Number.isNaN(r.a.winRate)).toBe(false)
    expect(r.recommendation).toContain("Neither profile")
  })
})

describe("Telegram console authorization", () => {
  function makeUpdate(chatId: number, text: string, updateId = 1) {
    return {
      ok: true,
      result: [
        { update_id: updateId, message: { message_id: 1, from: { id: chatId, username: "tester" }, chat: { id: chatId }, text } },
      ],
    }
  }

  it("rejects commands from unauthorized chat ids and audit-logs the attempt", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token")
    vi.stubEnv("TELEGRAM_CHAT_ID", "111")
    const sent: Array<{ url: string; body?: string }> = []
    let delivered = false
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      sent.push({ url: u, body: init?.body ? String(init.body) : undefined })
      if (u.includes("getUpdates")) {
        // Deliver the update exactly once, then park like a real long poll.
        if (!delivered) {
          delivered = true
          return new Response(JSON.stringify(makeUpdate(999, "/kill")), { status: 200 })
        }
        await new Promise((r) => setTimeout(r, 10_000))
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const { TelegramConsole } = await import("@/lib/v2/engine/telegram-console")
    const console_ = new TelegramConsole()
    // Drive exactly one poll cycle by calling the private handler through start/stop.
    console_.start()
    await new Promise((r) => setTimeout(r, 50))
    console_.stop()

    // The unauthorized sender got a rejection, not a kill confirmation.
    const replies = sent.filter((s) => s.url.includes("sendMessage"))
    expect(replies.length).toBeGreaterThan(0)
    expect(replies[0].body).toContain("Unauthorized")
    expect(replies[0].body).not.toContain("KILL")

    // And the attempt is in the audit log.
    const { queryAuditLog } = await import("@/lib/v2/engine/db")
    const rows = queryAuditLog({ search: "REJECTED", limit: 5 })
    expect(rows.length).toBe(1)
    expect(rows[0].message).toContain("999")
  })

  it("does not start without both token and chat id", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "")
    vi.stubEnv("TELEGRAM_CHAT_ID", "")
    const { startTelegramConsole } = await import("@/lib/v2/engine/telegram-console")
    expect(startTelegramConsole()).toBe(false)
  })

  it("unknown commands from an authorized chat get a help hint, not execution", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token")
    vi.stubEnv("TELEGRAM_CHAT_ID", "111")
    const sent: string[] = []
    let delivered = false
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes("getUpdates")) {
        if (!delivered) {
          delivered = true
          return new Response(JSON.stringify(makeUpdate(111, "/selfdestruct", 2)), { status: 200 })
        }
        await new Promise((r) => setTimeout(r, 10_000))
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
      }
      if (u.includes("sendMessage")) sent.push(init?.body ? String(init.body) : "")
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const { TelegramConsole } = await import("@/lib/v2/engine/telegram-console")
    const console_ = new TelegramConsole()
    console_.start()
    await new Promise((r) => setTimeout(r, 50))
    console_.stop()

    expect(sent.length).toBeGreaterThan(0)
    expect(sent[0]).toContain("Unknown command")
  })
})

describe("24h report", () => {
  it("builds a complete report on an empty ledger without throwing", async () => {
    const { build24hReport } = await import("@/lib/v2/engine/report")
    const { engine } = makeEngineDouble()
    const report = await build24hReport(engine as never)
    expect(report).toContain("24H PERFORMANCE REPORT")
    expect(report).toContain("Total: 0")
    expect(report.length).toBeLessThanOrEqual(4000)
  })
})
