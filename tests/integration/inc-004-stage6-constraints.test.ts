/**
 * INC-004 Stage 6 — UNIQUE constraint hardening.
 *
 * Fresh tmp SQLite per test via DB_PATH + vi.resetModules(), mirroring the
 * Stage 5 reconciler suite.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

type DbModule = typeof import("../../lib/v2/engine/db")
let db: DbModule

async function freshDb(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inc004-stage6-"))
  process.env.DB_PATH = path.join(tmp, "ledger.db")
  vi.resetModules()
  db = await import("../../lib/v2/engine/db")
  db.getDbHandle() // force schema init
}

beforeEach(async () => {
  await freshDb()
})

const baseIntent = (coid: string, nowMs = 1_000) => ({
  clientOrderId: coid,
  mode: "LIVE_V2",
  marketId: "m1",
  tokenId: "tok-up",
  side: "BUY" as const,
  price: 0.5,
  shares: 10,
  nowMs,
})

describe("INC-004 Stage 6 — UNIQUE constraint hardening", () => {
  it("hasIntentUniqueConstraints() returns true on a fresh schema", () => {
    expect(db.hasIntentUniqueConstraints()).toBe(true)
  })

  it("schema init is idempotent (safe re-apply on an existing DB)", async () => {
    // Reopen the same DB file — CREATE ... IF NOT EXISTS must not throw.
    const existing = process.env.DB_PATH!
    vi.resetModules()
    db = await import("../../lib/v2/engine/db")
    process.env.DB_PATH = existing
    db.getDbHandle()
    expect(db.hasIntentUniqueConstraints()).toBe(true)
  })

  it("rejects duplicate client_order_id at the DB level", () => {
    db.createPendingIntent(baseIntent("coid-dup"))
    expect(() => db.createPendingIntent(baseIntent("coid-dup"))).toThrow(/UNIQUE/i)
  })

  it("rejects duplicate exchange_order_id across intents", () => {
    const a = db.createPendingIntent(baseIntent("coid-a"))
    const b = db.createPendingIntent(baseIntent("coid-b"))
    db.markIntentSubmitted(a, 1_000)
    db.markIntentSubmitted(b, 1_000)
    db.markIntentResting(a, "exch-shared", 1_000)
    expect(() => db.markIntentResting(b, "exch-shared", 1_000)).toThrow(/UNIQUE/i)
  })

  it("allows many intents with NULL exchange_order_id (partial index)", () => {
    for (let i = 0; i < 5; i++) db.createPendingIntent(baseIntent(`coid-null-${i}`))
    expect(db.hasIntentUniqueConstraints()).toBe(true)
  })

  it("rejects duplicate quarantine of the same exchange_order_id", () => {
    db.quarantineExchangeOrder({
      exchangeOrderId: "exch-q-1",
      clientOrderId: "coid-q",
      intentId: null,
      reason: "duplicate_for_intent",
      payload: null,
      nowMs: 1_000,
    })
    expect(() =>
      db.quarantineExchangeOrder({
        exchangeOrderId: "exch-q-1",
        clientOrderId: "coid-q",
        intentId: null,
        reason: "duplicate_for_intent",
        payload: null,
        nowMs: 1_000,
      }),
    ).toThrow(/UNIQUE/i)
  })
})