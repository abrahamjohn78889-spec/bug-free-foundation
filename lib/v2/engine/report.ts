/**
 * /report — on-demand 24-hour performance report for the Telegram console.
 *
 * Generated ONLY when the operator runs /report (never scheduled, never
 * pushed automatically). Covers the EXACT trailing 24 hours from the moment
 * of execution. Read-only: pulls from the ledger, order log, audit log,
 * engine snapshot, and system monitor without mutating anything.
 */

import { getDbHandle as getDb, dbStats } from "./db"
import { getActiveProfileName } from "./strategy-profiles"
import { systemInfo } from "./system-monitor"
import type { Edge5Engine } from "./engine"

const esc = (s: string) => s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))
const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`)
const dur = (sec: number) => {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(sec % 60)}s`
}

/** Build the full 24h report as a Telegram HTML message. */
export async function build24hReport(engine: Edge5Engine): Promise<string> {
  const now = Date.now()
  const from = now - 24 * 3_600_000
  const snap = engine.snapshot()
  const d = getDb()

  // ---- Trades in the window (both settled and any still open) ----
  const trades = d
    .prepare(
      `SELECT price, shares, cost, result, pnl, balance_after, entry_at_ms,
              CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS created_ms,
              CASE WHEN settled_at IS NULL THEN NULL ELSE CAST(strftime('%s', settled_at) AS INTEGER) * 1000 END AS settled_ms
       FROM trades
       WHERE mode = ? AND status = 'SETTLED' AND result IS NOT NULL
         AND CAST(strftime('%s', COALESCE(settled_at, created_at)) AS INTEGER) * 1000 >= ?
       ORDER BY id ASC`,
    )
    .all(snap.mode, from) as Array<{
    price: number
    shares: number
    cost: number
    result: string
    pnl: number | null
    balance_after: number | null
    entry_at_ms: number | null
    created_ms: number
    settled_ms: number | null
  }>

  let wins = 0
  let losses = 0
  let scratches = 0
  let grossProfit = 0
  let grossLoss = 0
  let largestWin = 0
  let largestLoss = 0
  let entrySum = 0
  let settleSum = 0
  let settleN = 0
  let holdSum = 0
  let holdN = 0
  let peak = -Infinity
  let maxDd = 0
  let startBankroll: number | null = null
  let endBankroll: number | null = null

  for (const t of trades) {
    const pnl = t.pnl ?? 0
    if (t.result === "WIN") {
      wins++
      grossProfit += pnl
      largestWin = Math.max(largestWin, pnl)
      settleSum += 1
      settleN++
    } else if (t.result === "LOSS") {
      losses++
      grossLoss += Math.abs(pnl)
      largestLoss = Math.min(largestLoss, pnl)
      settleN++
    } else scratches++
    entrySum += t.price
    const entryTs = t.entry_at_ms ?? t.created_ms
    if (t.settled_ms !== null && t.settled_ms >= entryTs) {
      holdSum += (t.settled_ms - entryTs) / 1000
      holdN++
    }
    if (t.balance_after !== null) {
      if (startBankroll === null) startBankroll = t.balance_after - pnl
      endBankroll = t.balance_after
      peak = Math.max(peak, t.balance_after)
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - t.balance_after) / peak) * 100)
    }
  }
  const decided = wins + losses
  const winRate = decided > 0 ? (wins / decided) * 100 : 0
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0
  const net = grossProfit - grossLoss
  const roi = startBankroll && startBankroll > 0 && endBankroll !== null ? ((endBankroll - startBankroll) / startBankroll) * 100 : null
  const currentPool = snap.balance + snap.dustReserve
  const currentDd = peak > 0 ? Math.max(0, ((peak - currentPool) / peak) * 100) : 0

  // ---- Order log counters in the window ----
  const orderCount = (event: string) =>
    (d.prepare(`SELECT COUNT(*) AS n FROM order_log WHERE mode = ? AND event = ? AND ts_ms >= ?`).get(snap.mode, event, from) as { n: number }).n
  const filled = orderCount("FILLED")
  const submitted = orderCount("SUBMITTED")
  const errors = orderCount("ERROR")
  const cancelled = orderCount("CANCELLED")
  const replaced = orderCount("REPLACED")
  // Missed = submitted but never filled and eventually cancelled/expired.
  const missed = Math.max(0, submitted - filled)

  // ---- Ops counters from the audit/event trail ----
  const auditCount = (like: string) =>
    (d.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ts_ms >= ? AND message LIKE ?`).get(from, like) as { n: number }).n
  const watchdogRecoveries = auditCount("%watchdog%recover%") + auditCount("%Watchdog%restart%")
  const reconnects = auditCount("%reconnect%")
  const restErrors = auditCount("%REST%error%") + auditCount("%HTTP%failed%")
  const wsErrors = auditCount("%WebSocket%error%") + auditCount("%WS%closed%")

  // ---- System state ----
  const sys = await systemInfo()
  const stats = dbStats(false)
  const activeProfile = getActiveProfileName()

  const fmt = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC"
  const sloLine = snap.standingLimitOrder
    ? `trigger ${snap.standingLimitOrder.triggerPrice.toFixed(2)} → limit ${snap.standingLimitOrder.limitPrice.toFixed(2)} (${snap.standingLimitOrder.sizingMode})`
    : "none"

  return [
    `<b>EDGE 5 — 24H PERFORMANCE REPORT</b>`,
    `<i>${fmt(from)} → ${fmt(now)}</i>`,
    ``,
    `<b>BANKROLL</b>`,
    `Start: ${startBankroll !== null ? usd(startBankroll) : "— (no trades in window)"}`,
    `End: ${endBankroll !== null ? usd(endBankroll) : usd(currentPool)}`,
    `Net: ${usd(net)}  ROI: ${pct(roi)}`,
    `Gross profit: ${usd(grossProfit)}  Gross loss: ${usd(-grossLoss)}`,
    ``,
    `<b>TRADES</b>`,
    `Total: ${trades.length}  W: ${wins}  L: ${losses}  Scratch: ${scratches}`,
    `Win rate: ${pct(decided > 0 ? winRate : null)}  Profit factor: ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"}`,
    `Largest win: ${usd(largestWin)}  Largest loss: ${usd(largestLoss)}`,
    `Max drawdown: ${pct(startBankroll !== null ? maxDd : null)}  Current drawdown: ${pct(startBankroll !== null ? currentDd : null)}`,
    `Avg entry: ${trades.length > 0 ? (entrySum / trades.length).toFixed(3) : "—"}  Avg settlement: ${settleN > 0 ? (settleSum / settleN).toFixed(3) : "—"}`,
    `Avg holding: ${holdN > 0 ? dur(holdSum / holdN) : "—"}`,
    ``,
    `<b>ORDERS</b>`,
    `Filled: ${filled}  Submitted: ${submitted}  Missed: ${missed}`,
    `Cancelled: ${cancelled}  Replaced: ${replaced}  Errors: ${errors}`,
    `SLO fires (lifetime): ${snap.standingLimitOrder?.executionCount ?? 0}`,
    ``,
    `<b>RELIABILITY</b>`,
    `Watchdog recoveries: ${watchdogRecoveries}  Reconnects: ${reconnects}`,
    `REST errors: ${restErrors}  WS errors: ${wsErrors}`,
    ``,
    `<b>SYSTEM</b>`,
    `CPU: ${sys.cpu.usagePct.toFixed(0)}%  RAM: ${sys.memory.usedPct.toFixed(0)}% (proc ${(sys.memory.processRssBytes / 1048576).toFixed(0)} MB)`,
    `Process uptime: ${dur(sys.uptime.processSec)}  DB: ${(stats.fileSizeBytes / 1048576).toFixed(1)} MB`,
    `Version: ${esc(sys.engineVersion)}  Commit: ${sys.git.commit ? esc(`${sys.git.branch ?? "?"}@${sys.git.commit}`) : "—"}`,
    ``,
    `<b>CONFIGURATION</b>`,
    `Pipeline: ${snap.mode}  Engine: ${snap.running ? "RUNNING" : "STOPPED"}`,
    `Profile: ${activeProfile ? esc(activeProfile) : "— (none loaded)"}`,
    `SLO: ${esc(sloLine)}`,
    `Risk: daily loss ${usd(snap.risk.limits.maxDailyLossUsd)} · order cap ${usd(snap.risk.limits.maxOrderNotionalUsd)} · ${snap.risk.limits.maxDailyOrders} orders/day · ${snap.risk.limits.maxSharesPerOrder} shares/order`,
    snap.risk.killSwitch?.engaged ? `⚠ KILL SWITCH ENGAGED: ${esc(snap.risk.killSwitch.reason ?? "")}` : ``,
  ]
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n")
}
