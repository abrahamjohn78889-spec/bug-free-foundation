import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import {
  insertLatencySample,
  recordLatencyFillObserved,
  getLatencyReport,
  getLatencySamples,
  flushWriteQueueSync,
  getDbHandle,
} from "@/lib/v2/engine/db"

// Fresh DB per test — the module-level `db` handle is replaced by pointing
// DB_PATH at a tmp file and re-invoking getDbHandle().
function useFreshDb() {
  const file = path.join(os.tmpdir(), `latency-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
  process.env.DB_PATH = file
  // Force re-init by discarding cached handle (better-sqlite3 keyed by handle).
  const h = getDbHandle()
  // sanity: WAL PRAGMA succeeded
  expect(h).toBeInstanceOf(Database)
  return { file }
}

describe("persistent execution-latency samples", () => {
  beforeEach(() => { useFreshDb() })

  it("inserts a sample and returns it in the recent list", () => {
    insertLatencySample({
      mode: "PAPER_V1",
      marketId: "mkt-1",
      exchangeOrderId: "ord-A",
      side: "UP",
      shares: 10,
      limitPrice: 0.9,
      quoteAgeMs: 12,
      decisionMs: 3,
      preSubmitMs: 7,
      submitMs: 22,
      fillCheckMs: 18,
      totalMs: 62,
      submitAtMs: Date.now(),
    })
    flushWriteQueueSync()

    const rows = getLatencySamples("PAPER_V1", 10)
    expect(rows).toHaveLength(1)
    expect(rows[0].exchange_order_id).toBe("ord-A")
    expect(rows[0].submit_ms).toBe(22)
    expect(rows[0].fill_observed_ms).toBeNull()
  })

  it("records observed fill latency keyed by exchange order id", () => {
    const submitAtMs = Date.now()
    insertLatencySample({
      mode: "LIVE_V2", marketId: "m", exchangeOrderId: "ord-B",
      side: "DOWN", shares: 5, limitPrice: 0.5,
      quoteAgeMs: 0, decisionMs: 1, preSubmitMs: 2, submitMs: 3, fillCheckMs: 4, totalMs: 10,
      submitAtMs,
    })
    flushWriteQueueSync()
    recordLatencyFillObserved("ord-B", 0.5, submitAtMs + 137)
    flushWriteQueueSync()

    const [row] = getLatencySamples("LIVE_V2", 1)
    expect(row.fill_observed_ms).toBe(137)
    expect(row.filled_price).toBeCloseTo(0.5)
  })

  it("computes p50/p95/max percentiles across the window", () => {
    const now = Date.now()
    for (let i = 1; i <= 20; i++) {
      insertLatencySample({
        mode: "PAPER_V1", marketId: "m", exchangeOrderId: `o-${i}`,
        side: "UP", shares: 1, limitPrice: 0.9,
        quoteAgeMs: 0, decisionMs: 0, preSubmitMs: 0,
        submitMs: i * 10,        // 10..200
        fillCheckMs: 0, totalMs: i * 10, submitAtMs: now,
      })
    }
    flushWriteQueueSync()
    const report = getLatencyReport("PAPER_V1", 60 * 60 * 1000)
    expect(report.sampleCount).toBe(20)
    expect(report.phases.submit.max).toBe(200)
    // p50 at index floor(20*0.5)=10 → 11th value = 110
    expect(report.phases.submit.p50).toBe(110)
    // p95 at index floor(20*0.95)=19 → 20th value = 200
    expect(report.phases.submit.p95).toBe(200)
  })

  it("second fill observation for the same order id is a no-op", () => {
    const submitAtMs = Date.now()
    insertLatencySample({
      mode: "LIVE_V2", marketId: "m", exchangeOrderId: "ord-idem",
      side: "UP", shares: 1, limitPrice: 0.9,
      quoteAgeMs: 0, decisionMs: 0, preSubmitMs: 0, submitMs: 0, fillCheckMs: 0, totalMs: 0,
      submitAtMs,
    })
    flushWriteQueueSync()
    recordLatencyFillObserved("ord-idem", 0.9, submitAtMs + 100)
    flushWriteQueueSync()
    recordLatencyFillObserved("ord-idem", 0.9, submitAtMs + 999) // must not overwrite
    flushWriteQueueSync()
    const [row] = getLatencySamples("LIVE_V2", 1)
    expect(row.fill_observed_ms).toBe(100)
  })
})
