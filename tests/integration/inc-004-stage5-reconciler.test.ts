/**
 * INC-004 Stage 5 — Reconciler recovery + quarantine.
 *
 * Deterministic tests against a tmp SQLite file per test. Each case builds an
 * AMBIGUOUS intent via the Stage 2 lifecycle helpers, then calls
 * `recoverAmbiguousIntents` with a scripted ExchangeIntentLookup.
 *
 * The four contract cases match the file-level Stage 5 spec in
 * lib/v2/engine/reconciler.ts:
 *   • 0 matches  → FAILED (reason "reconciled_absent")
 *   • 1 match    → RESTING with the returned exchange id
 *   • 2 matches  → RESTING with the lexicographically-lowest id; the other
 *                  is quarantined with reason "duplicate_for_intent"
 *   • lookup throws → intent stays AMBIGUOUS; recovery result records an error
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

type DbModule = typeof import("../../lib/v2/engine/db")
type ReconModule = typeof import("../../lib/v2/engine/reconciler")

let db: DbModule
let recon: ReconModule

async function freshDb(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inc004-stage5-"))
  process.env.DB_PATH = path.join(tmp, "ledger.db")
  vi.resetModules()
  db = await import("../../lib/v2/engine/db")
  recon = await import("../../lib/v2/engine/reconciler")
}

function makeAmbiguousIntent(coid: string, nowMs = 1_000): number {
  const id = db.createPendingIntent({
    clientOrderId: coid,
    mode: "LIVE_V2",
    marketId: "m1",
    tokenId: "tok-up",
    side: "BUY",
    price: 0.5,
    shares: 10,
    nowMs,
  })
  db.markIntentSubmitted(id, nowMs + 1)
  db.markIntentAmbiguous(id, "LOST_ACK", nowMs + 2)
  return id
}

beforeEach(async () => {
  await freshDb()
})

describe("INC-004 Stage 5 — recoverAmbiguousIntents", () => {
  it("0 exchange matches → intent transitions AMBIGUOUS → FAILED (reconciled_absent)", async () => {
    const id = makeAmbiguousIntent("coid-absent-1")
    const result = await recon.recoverAmbiguousIntents(
      { findOrdersByClientOrderId: async () => [] },
      2_000,
    )

    expect(result).toMatchObject({ scanned: 1, resting: 0, failed: 1, quarantined: 0, errors: 0 })
    const row = db.getIntentById(id)!
    expect(row.status).toBe("FAILED")
    expect(row.last_error).toBe("reconciled_absent")
    expect(row.failed_at_ms).toBe(2_000)
    expect(db.listQuarantinedExchangeOrders()).toHaveLength(0)
  })

  it("1 exchange match → intent transitions AMBIGUOUS → RESTING with that exchange id", async () => {
    const id = makeAmbiguousIntent("coid-one-1")
    const result = await recon.recoverAmbiguousIntents(
      { findOrdersByClientOrderId: async () => [{ exchangeOrderId: "exch-9" }] },
      3_000,
    )

    expect(result).toMatchObject({ scanned: 1, resting: 1, failed: 0, quarantined: 0, errors: 0 })
    const row = db.getIntentById(id)!
    expect(row.status).toBe("RESTING")
    expect(row.exchange_order_id).toBe("exch-9")
    expect(row.resting_at_ms).toBe(3_000)
    expect(row.last_error).toBeNull()
    expect(db.listQuarantinedExchangeOrders()).toHaveLength(0)
  })

  it("multiple exchange matches → lowest id promoted, others quarantined", async () => {
    const id = makeAmbiguousIntent("coid-dup-1")
    const result = await recon.recoverAmbiguousIntents(
      {
        findOrdersByClientOrderId: async () => [
          { exchangeOrderId: "exch-cccc", raw: { note: "third" } },
          { exchangeOrderId: "exch-aaaa", raw: { note: "canonical" } },
          { exchangeOrderId: "exch-bbbb", raw: { note: "dup" } },
        ],
      },
      4_000,
    )

    expect(result).toMatchObject({ scanned: 1, resting: 1, failed: 0, quarantined: 2, errors: 0 })
    const row = db.getIntentById(id)!
    expect(row.status).toBe("RESTING")
    expect(row.exchange_order_id).toBe("exch-aaaa")

    const quarantined = db.listQuarantinedExchangeOrders()
    expect(quarantined).toHaveLength(2)
    expect(quarantined.map((q) => q.exchange_order_id).sort()).toEqual(["exch-bbbb", "exch-cccc"])
    for (const q of quarantined) {
      expect(q.reason).toBe("duplicate_for_intent")
      expect(q.intent_id).toBe(id)
      expect(q.client_order_id).toBe("coid-dup-1")
      expect(q.quarantined_at_ms).toBe(4_000)
      expect(JSON.parse(q.payload!)).toHaveProperty("note")
    }
  })

  it("lookup throws → intent stays AMBIGUOUS and error is reported", async () => {
    const id = makeAmbiguousIntent("coid-err-1")
    const result = await recon.recoverAmbiguousIntents(
      {
        findOrdersByClientOrderId: async () => {
          throw new Error("exchange 503")
        },
      },
      5_000,
    )

    expect(result).toMatchObject({ scanned: 1, resting: 0, failed: 0, quarantined: 0, errors: 1 })
    expect(result.details[0]).toMatchObject({ intentId: id, outcome: "error" })
    expect(result.details[0].error).toMatch(/503/)
    const row = db.getIntentById(id)!
    expect(row.status).toBe("AMBIGUOUS")
  })

  it("processes multiple ambiguous intents in a single pass without cross-contamination", async () => {
    const idAbsent = makeAmbiguousIntent("coid-batch-absent", 1_000)
    const idResting = makeAmbiguousIntent("coid-batch-resting", 1_100)
    const idDup = makeAmbiguousIntent("coid-batch-dup", 1_200)

    const script: Record<string, Array<{ exchangeOrderId: string }>> = {
      "coid-batch-absent": [],
      "coid-batch-resting": [{ exchangeOrderId: "exch-solo" }],
      "coid-batch-dup": [{ exchangeOrderId: "exch-y" }, { exchangeOrderId: "exch-x" }],
    }
    const result = await recon.recoverAmbiguousIntents(
      { findOrdersByClientOrderId: async (coid) => script[coid] ?? [] },
      9_000,
    )

    expect(result).toMatchObject({ scanned: 3, resting: 2, failed: 1, quarantined: 1, errors: 0 })
    expect(db.getIntentById(idAbsent)!.status).toBe("FAILED")
    expect(db.getIntentById(idResting)!.status).toBe("RESTING")
    expect(db.getIntentById(idResting)!.exchange_order_id).toBe("exch-solo")
    const dupRow = db.getIntentById(idDup)!
    expect(dupRow.status).toBe("RESTING")
    expect(dupRow.exchange_order_id).toBe("exch-x")
    const q = db.listQuarantinedExchangeOrders()
    expect(q).toHaveLength(1)
    expect(q[0].exchange_order_id).toBe("exch-y")
    expect(q[0].intent_id).toBe(idDup)
  })

  it("does not create new intents (row count unchanged after recovery)", async () => {
    makeAmbiguousIntent("coid-count-1", 100)
    makeAmbiguousIntent("coid-count-2", 200)
    const before = (db.getDbHandle().prepare("SELECT COUNT(*) AS n FROM order_intents").get() as {
      n: number
    }).n
    await recon.recoverAmbiguousIntents(
      { findOrdersByClientOrderId: async () => [{ exchangeOrderId: "exch-1" }] },
      500,
    )
    const after = (db.getDbHandle().prepare("SELECT COUNT(*) AS n FROM order_intents").get() as {
      n: number
    }).n
    expect(after).toBe(before)
  })
})
