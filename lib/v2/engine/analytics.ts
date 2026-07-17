import { Bankroll } from "./bankroll"
import { exportTrades, recentOrderLogs } from "./db"
import type { PipelineMode } from "./types"

// ------------------------------------------------------------
// Advanced analytics computed from the permanent trades ledger
// + order_log audit trail. Read-only: never touches trading.
// ------------------------------------------------------------

export interface AnalyticsSummary {
  totalTrades: number
  wins: number
  losses: number
  scratches: number
  winRate: number
  lossRate: number
  profitFactor: number | null
  totalReturnUsd: number
  roiPct: number | null
  avgTradeUsd: number
  avgWinUsd: number
  avgLossUsd: number
  largestWinUsd: number
  largestLossUsd: number
  avgHoldingTimeSec: number | null
  avgEntryPrice: number | null
  avgEntrySecIntoSlot: number | null
  avgDailyProfitUsd: number
  avgDailyLossUsd: number
  maxDrawdownUsd: number
  maxDrawdownPct: number | null
  currentStreak: { kind: "WIN" | "LOSS" | "NONE"; length: number }
  longestWinStreak: number
  longestLossStreak: number
  fillRate: number | null
  rejectedOrders: number
  tradingDays: number
  bankrollSeries: Array<{ t: number; balance: number }>
  dailyPnl: Array<{ date: string; pnl: number; trades: number }>
  /** Ledger-derived balance = last settled balance_after (null when no settles).
   *  SINGLE-SOURCE AGREEMENT: must match bankrollPool ± open costs. */
  ledgerBalance: number | null
  /** Live kv bankroll pool (balance + dust reserve) at computation time. */
  bankrollPool: number
}

const SLOT_MS = 5 * 60_000

export function computeAnalytics(mode: PipelineMode): AnalyticsSummary {
  const all = exportTrades(mode)
  const settled = all.filter((r) => r.status === "SETTLED")

  const wins = settled.filter((r) => r.result === "WIN")
  const losses = settled.filter((r) => r.result === "LOSS")
  const scratches = settled.filter((r) => r.result === "SCRATCH")
  const decided = wins.length + losses.length

  const pnlOf = (r: Record<string, unknown>) => Number(r.pnl ?? 0)
  const grossWin = wins.reduce((s, r) => s + pnlOf(r), 0)
  const grossLoss = Math.abs(losses.reduce((s, r) => s + pnlOf(r), 0))
  const totalReturn = settled.reduce((s, r) => s + pnlOf(r), 0)

  // Holding time: entry_at_ms → settled_at (only rows that carry entry_at_ms).
  const holdSamples = settled
    .map((r) => {
      const entry = Number(r.entry_at_ms ?? 0)
      const settledAt = Date.parse(`${String(r.settled_at)}Z`)
      return entry > 0 && Number.isFinite(settledAt) && settledAt > entry ? (settledAt - entry) / 1000 : null
    })
    .filter((v): v is number => v !== null)

  // Entry timing within the 5-minute slot (seconds after slot open).
  const entrySamples = settled
    .map((r) => {
      const entry = Number(r.entry_at_ms ?? 0)
      const slotEnd = Number(r.slot_end_ms ?? 0)
      if (entry <= 0 || slotEnd <= 0) return null
      const intoSlot = (entry - (slotEnd - SLOT_MS)) / 1000
      return intoSlot >= 0 && intoSlot <= 300 ? intoSlot : null
    })
    .filter((v): v is number => v !== null)

  const avgEntryPrice = settled.length
    ? settled.reduce((s, r) => s + Number(r.price ?? 0), 0) / settled.length
    : null

  // Bankroll growth series + drawdown from balance_after (chronological).
  const bankrollSeries: Array<{ t: number; balance: number }> = []
  let peak = Number.NEGATIVE_INFINITY
  let maxDdUsd = 0
  let maxDdPct: number | null = null
  for (const r of settled) {
    const t = Date.parse(`${String(r.settled_at)}Z`)
    const balance = Number(r.balance_after ?? 0)
    if (!Number.isFinite(t) || !Number.isFinite(balance)) continue
    bankrollSeries.push({ t, balance })
    if (balance > peak) peak = balance
    const dd = peak - balance
    if (dd > maxDdUsd) {
      maxDdUsd = dd
      maxDdPct = peak > 0 ? (dd / peak) * 100 : null
    }
  }
  // ROI relative to the earliest known balance (balance before first PnL).
  const first = bankrollSeries[0]
  const startBalance = first ? first.balance - pnlOf(settled[0]) : null
  const roiPct = startBalance && startBalance > 0 ? (totalReturn / startBalance) * 100 : null

  // Streaks over decided trades (chronological; scratches don't break streaks).
  let currentKind: "WIN" | "LOSS" | "NONE" = "NONE"
  let currentLen = 0
  let bestWin = 0
  let bestLoss = 0
  for (const r of settled) {
    if (r.result !== "WIN" && r.result !== "LOSS") continue
    const kind = r.result as "WIN" | "LOSS"
    if (kind === currentKind) currentLen += 1
    else { currentKind = kind; currentLen = 1 }
    if (kind === "WIN") bestWin = Math.max(bestWin, currentLen)
    else bestLoss = Math.max(bestLoss, currentLen)
  }

  // Daily PnL buckets (UTC date of settlement).
  const daily = new Map<string, { pnl: number; trades: number }>()
  for (const r of settled) {
    const date = String(r.settled_at ?? "").slice(0, 10)
    if (!date) continue
    const cur = daily.get(date) ?? { pnl: 0, trades: 0 }
    cur.pnl += pnlOf(r)
    cur.trades += 1
    daily.set(date, cur)
  }
  const dailyPnl = [...daily.entries()]
    .map(([date, v]) => ({ date, pnl: Math.round(v.pnl * 100) / 100, trades: v.trades }))
    .sort((a, b) => a.date.localeCompare(b.date))
  const profitDays = dailyPnl.filter((d) => d.pnl > 0)
  const lossDays = dailyPnl.filter((d) => d.pnl < 0)

  // Fill rate + rejections from order_log (bounded window of recent activity).
  let fillRate: number | null = null
  let rejectedOrders = 0
  try {
    const logs = recentOrderLogs(mode, 2000)
    const submitted = logs.filter((l) => l.event === "SUBMITTED").length
    const filled = logs.filter((l) => l.event === "FILLED").length
    rejectedOrders = logs.filter((l) => l.event === "ERROR").length
    fillRate = submitted > 0 ? Math.min((filled / submitted) * 100, 100) : null
  } catch {
    /* analytics never throws */
  }

  const round2 = (v: number) => Math.round(v * 100) / 100

  return {
    totalTrades: settled.length,
    wins: wins.length,
    losses: losses.length,
    scratches: scratches.length,
    winRate: decided > 0 ? round2((wins.length / decided) * 100) : 0,
    lossRate: decided > 0 ? round2((losses.length / decided) * 100) : 0,
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : grossWin > 0 ? null : 0,
    totalReturnUsd: round2(totalReturn),
    roiPct: roiPct !== null ? round2(roiPct) : null,
    avgTradeUsd: settled.length ? round2(totalReturn / settled.length) : 0,
    avgWinUsd: wins.length ? round2(grossWin / wins.length) : 0,
    avgLossUsd: losses.length ? round2(-grossLoss / losses.length) : 0,
    largestWinUsd: wins.length ? round2(Math.max(...wins.map(pnlOf))) : 0,
    largestLossUsd: losses.length ? round2(Math.min(...losses.map(pnlOf))) : 0,
    avgHoldingTimeSec: holdSamples.length ? Math.round(holdSamples.reduce((s, v) => s + v, 0) / holdSamples.length) : null,
    avgEntryPrice: avgEntryPrice !== null ? Math.round(avgEntryPrice * 10000) / 10000 : null,
    avgEntrySecIntoSlot: entrySamples.length ? Math.round(entrySamples.reduce((s, v) => s + v, 0) / entrySamples.length) : null,
    avgDailyProfitUsd: profitDays.length ? round2(profitDays.reduce((s, d) => s + d.pnl, 0) / profitDays.length) : 0,
    avgDailyLossUsd: lossDays.length ? round2(lossDays.reduce((s, d) => s + d.pnl, 0) / lossDays.length) : 0,
    maxDrawdownUsd: round2(maxDdUsd),
    maxDrawdownPct: maxDdPct !== null ? round2(maxDdPct) : null,
    currentStreak: { kind: currentKind, length: currentLen },
    longestWinStreak: bestWin,
    longestLossStreak: bestLoss,
    fillRate: fillRate !== null ? round2(fillRate) : null,
    rejectedOrders,
    tradingDays: dailyPnl.length,
    bankrollSeries: bankrollSeries.length > 500
      ? bankrollSeries.filter((_, i) => i % Math.ceil(bankrollSeries.length / 500) === 0 || i === bankrollSeries.length - 1)
      : bankrollSeries,
    dailyPnl,
    ledgerBalance: bankrollSeries.length ? round2(bankrollSeries[bankrollSeries.length - 1].balance) : null,
    bankrollPool: (() => {
      const b = new Bankroll(mode)
      return round2(b.balance + b.dustReserve)
    })(),
  }
}
