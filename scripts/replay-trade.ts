#!/usr/bin/env npx tsx
// ------------------------------------------------------------------
// FORENSIC TRADE REPLAY CLI
//
//   pnpm replay <tradeId> [--db path/to/edge5.db] [--json]
//
// Reconstructs every piece of stored evidence about one trade —
// trade row, explanation/feedAudit, order-log chain, audit-log
// lines, sibling trades — and prints a chronological report with a
// direction VERDICT. Read-only: never writes to the database.
//
// Run it on the production machine against the live ledger (default
// data/edge5.db) or point --db at any copy/backup.
// ------------------------------------------------------------------
import Database from "better-sqlite3"
import path from "node:path"
import fs from "node:fs"
import { buildTradeReplay, type TradeReplayBundle } from "../lib/v2/engine/trade-replay"

function usage(): never {
  console.log("Usage: pnpm replay <tradeId> [--db path/to/edge5.db] [--json]")
  process.exit(1)
}

const args = process.argv.slice(2)
const tradeId = Number(args.find((a) => /^\d+$/.test(a)))
if (!Number.isFinite(tradeId) || tradeId <= 0) usage()
const dbFlagIdx = args.indexOf("--db")
const dbPath = dbFlagIdx >= 0 ? args[dbFlagIdx + 1] : (process.env.DB_PATH ?? "data/edge5.db")
const asJson = args.includes("--json")

const fullPath = path.resolve(process.cwd(), dbPath)
if (!fs.existsSync(fullPath)) {
  console.error(`Database not found: ${fullPath}\nPass --db <path> to point at the ledger file.`)
  process.exit(1)
}

const db = new Database(fullPath, { readonly: true, fileMustExist: true })

let bundle: TradeReplayBundle
try {
  bundle = buildTradeReplay(db, tradeId)
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
} finally {
  db.close()
}

if (asJson) {
  console.log(JSON.stringify(bundle, null, 2))
  process.exit(0)
}

// ---------------- human-readable report ----------------
const { trade, feedAudit, explanation, orderLog, auditLog, siblingTrades, verdict, slotWindow } = bundle
const et = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", hour12: true })
const line = "=".repeat(72)

console.log(line)
console.log(`FORENSIC REPLAY — Trade #${trade.id} [${trade.mode}]`)
console.log(line)
console.log(`Market:        ${trade.market_id}`)
console.log(`Slot window:   ${slotWindow.startIso} → ${slotWindow.endIso}`)
console.log(`               (${et(trade.slot_end_ms - 5 * 60_000)} → ${et(trade.slot_end_ms)} ET)`)
console.log(`Entered:       ${trade.side} @ $${trade.price.toFixed(4)} × ${trade.shares} shares = $${trade.cost.toFixed(2)}`)
if (trade.entry_at_ms) console.log(`Entry time:    ${new Date(trade.entry_at_ms).toISOString()} (${et(trade.entry_at_ms)} ET)`)
console.log(`Result:        ${trade.result}  |  PnL $${trade.pnl.toFixed(2)}  |  balance after $${trade.balance_after.toFixed(2)}`)
console.log(`Created/Settled: ${trade.created_at} / ${trade.settled_at} (UTC)`)

console.log(`\n--- STORED EXPLANATION ${"-".repeat(47)}`)
if (explanation) {
  for (const [k, v] of Object.entries(explanation)) {
    if (k === "feedAudit") continue
    console.log(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
  }
} else {
  console.log("  (none stored)")
}

console.log(`\n--- TRIGGER-TIME FEED SNAPSHOT (Phase 1 feedAudit) ${"-".repeat(19)}`)
if (feedAudit) {
  const q = feedAudit.quotes
  console.log(`  generation ${feedAudit.generation}  seq ${feedAudit.sequence}  confidence ${feedAudit.confidence}`)
  if (feedAudit.snapshotAtMs) console.log(`  snapshot at ${new Date(feedAudit.snapshotAtMs).toISOString()} (${et(feedAudit.snapshotAtMs)} ET)`)
  if (q) {
    console.log(`  UP   ask $${q.up.price.toFixed(4)}  [${q.up.source}, age ${q.up.ageMs}ms, latency ${q.up.latencyMs ?? "-"}ms]`)
    console.log(`  DOWN ask $${q.down.price.toFixed(4)}  [${q.down.source}, age ${q.down.ageMs}ms, latency ${q.down.latencyMs ?? "-"}ms]`)
  }
  if (feedAudit.majority)
    console.log(`  majority: ${feedAudit.majority.side} (UP ${feedAudit.majority.upPct ?? "?"}% / DOWN ${feedAudit.majority.downPct ?? "?"}%)`)
  console.log(`  trigger $${feedAudit.triggerPrice?.toFixed(2) ?? "?"} [${feedAudit.triggerMode ?? "?"}] → limit $${feedAudit.limitPrice?.toFixed(2) ?? "?"}`)
  if (feedAudit.lock)
    console.log(`  lock: gen ${feedAudit.lock.generation} @ ${new Date(feedAudit.lock.lockedAtMs).toISOString()} market ${feedAudit.lock.marketId}`)
} else {
  console.log("  NOT AVAILABLE — this trade predates the Phase 1 permanent audit record.")
}

console.log(`\n--- ORDER LOG CHAIN (${orderLog.length} events) ${"-".repeat(38)}`)
for (const r of orderLog) {
  console.log(
    `  ${new Date(r.ts_ms).toISOString()}  ${r.event.padEnd(9)} ${(r.side ?? "-").padEnd(4)} ${
      r.price !== null ? "$" + r.price.toFixed(4) : "-"
    }  ${r.phase ?? ""}${r.detail ? `\n      ${r.detail}` : ""}`,
  )
}
if (orderLog.length === 0) console.log("  (no order_log rows — possibly pruned by 30-day retention)")

if (auditLog.length > 0) {
  console.log(`\n--- AUDIT LOG (slot window ±margin, ${auditLog.length} lines) ${"-".repeat(24)}`)
  for (const a of auditLog) console.log(`  ${new Date(a.ts_ms).toISOString()}  [${a.level}/${a.category}] ${a.message}`)
}

console.log(`\n--- SIBLING TRADES IN SAME SLOT (${siblingTrades.length}) ${"-".repeat(32)}`)
for (const s of siblingTrades) {
  console.log(`  #${s.id}: ${s.side} @ $${s.price.toFixed(4)} × ${s.shares} — ${s.result}, PnL $${s.pnl.toFixed(2)}`)
}
if (siblingTrades.length === 0) console.log("  (none)")

console.log(`\n${line}`)
console.log(`VERDICT: ${verdict.conclusion}`)
console.log(line)
for (const f of verdict.findings) console.log(`  • ${f}`)
if (verdict.missingEvidence.length > 0) {
  console.log(`\n  Missing evidence:`)
  for (const m of verdict.missingEvidence) console.log(`    - ${m}`)
}
console.log("")
