/**
 * STRATEGY COMPARISON — read-only analysis of two strategy profiles.
 *
 * Attribution model: trades are attributed to a profile by TIMESTAMP JOIN
 * against profile_sessions (the windows during which that profile was
 * loaded). This requires ZERO changes to the certified trade insertion or
 * settlement paths — the engine remains frozen.
 *
 * This module never mutates anything and never changes any strategy.
 */

import { getDbHandle as getDb } from "./db"
import { getProfile, getProfileSessions } from "./strategy-profiles"

export interface ProfileStats {
  profileName: string
  found: boolean
  sessionCount: number
  totalTrades: number
  wins: number
  losses: number
  scratches: number
  winRate: number
  roiPct: number | null
  netProfitUsd: number
  grossProfitUsd: number
  grossLossUsd: number
  profitFactor: number
  avgEntryPrice: number | null
  avgSettlementPrice: number | null
  avgHoldingTimeSec: number | null
  largestWinUsd: number
  largestLossUsd: number
  maxDrawdownPct: number | null
  longestWinStreak: number
  longestLossStreak: number
}

interface TradeRow {
  price: number
  shares: number
  cost: number
  result: string | null
  pnl: number | null
  balance_after: number | null
  entry_at_ms: number | null
  created_epoch_ms: number
  settled_epoch_ms: number | null
}

function emptyStats(name: string, found: boolean, sessionCount = 0): ProfileStats {
  return {
    profileName: name,
    found,
    sessionCount,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    scratches: 0,
    winRate: 0,
    roiPct: null,
    netProfitUsd: 0,
    grossProfitUsd: 0,
    grossLossUsd: 0,
    profitFactor: 0,
    avgEntryPrice: null,
    avgSettlementPrice: null,
    avgHoldingTimeSec: null,
    largestWinUsd: 0,
    largestLossUsd: 0,
    maxDrawdownPct: null,
    longestWinStreak: 0,
    longestLossStreak: 0,
  }
}

/** Compute the full metric set for one profile from its attributed trades. */
export function computeProfileStats(profileName: string): ProfileStats {
  const profile = getProfile(profileName)
  const sessions = getProfileSessions(profileName)
  if (!profile) return emptyStats(profileName, false)
  if (sessions.length === 0) return emptyStats(profileName, true, 0)

  const d = getDb()
  const rows = d
    .prepare(
      `SELECT price, shares, cost, result, pnl, balance_after, entry_at_ms,
              CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS created_epoch_ms,
              CASE WHEN settled_at IS NULL THEN NULL ELSE CAST(strftime('%s', settled_at) AS INTEGER) * 1000 END AS settled_epoch_ms
       FROM trades
       WHERE status = 'SETTLED' AND result IS NOT NULL
       ORDER BY id ASC`,
    )
    .all() as TradeRow[]

  // SQLite's created_at has SECOND granularity while session boundaries are
  // millisecond-precise. Floor the session start to the second so a trade
  // recorded in the same second as the profile load is still attributed;
  // conversely ceil the end so boundary trades are not dropped either.
  const inSession = (tsMs: number) =>
    sessions.some(
      (s) =>
        tsMs >= Math.floor(s.startMs / 1000) * 1000 &&
        (s.endMs === null || tsMs <= Math.ceil(s.endMs / 1000) * 1000),
    )
  const attributed = rows.filter((r) => inSession(r.entry_at_ms ?? r.created_epoch_ms))

  const stats = emptyStats(profileName, true, sessions.length)
  if (attributed.length === 0) return stats

  let grossProfit = 0
  let grossLoss = 0
  let entrySum = 0
  let settleSum = 0
  let settleN = 0
  let holdSum = 0
  let holdN = 0
  let winStreak = 0
  let lossStreak = 0
  let peakBalance = -Infinity
  let maxDrawdownPct = 0
  let firstBalance: number | null = null
  let lastBalance: number | null = null

  for (const t of attributed) {
    stats.totalTrades++
    const pnl = t.pnl ?? 0
    if (t.result === "WIN") {
      stats.wins++
      grossProfit += pnl
      winStreak++
      lossStreak = 0
      stats.longestWinStreak = Math.max(stats.longestWinStreak, winStreak)
      stats.largestWinUsd = Math.max(stats.largestWinUsd, pnl)
      // Binary settlement: winners settle at $1.00 per share.
      settleSum += 1
      settleN++
    } else if (t.result === "LOSS") {
      stats.losses++
      grossLoss += Math.abs(pnl)
      lossStreak++
      winStreak = 0
      stats.longestLossStreak = Math.max(stats.longestLossStreak, lossStreak)
      stats.largestLossUsd = Math.min(stats.largestLossUsd, pnl)
      settleSum += 0
      settleN++
    } else {
      stats.scratches++
      winStreak = 0
      lossStreak = 0
    }
    entrySum += t.price
    const entryTs = t.entry_at_ms ?? t.created_epoch_ms
    if (t.settled_epoch_ms !== null && t.settled_epoch_ms >= entryTs) {
      holdSum += (t.settled_epoch_ms - entryTs) / 1000
      holdN++
    }
    if (t.balance_after !== null) {
      if (firstBalance === null) firstBalance = t.balance_after - pnl
      lastBalance = t.balance_after
      peakBalance = Math.max(peakBalance, t.balance_after)
      if (peakBalance > 0) {
        const dd = ((peakBalance - t.balance_after) / peakBalance) * 100
        maxDrawdownPct = Math.max(maxDrawdownPct, dd)
      }
    }
  }

  const decided = stats.wins + stats.losses
  stats.winRate = decided > 0 ? (stats.wins / decided) * 100 : 0
  stats.netProfitUsd = grossProfit - grossLoss
  stats.grossProfitUsd = grossProfit
  stats.grossLossUsd = grossLoss
  stats.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0
  stats.avgEntryPrice = stats.totalTrades > 0 ? entrySum / stats.totalTrades : null
  stats.avgSettlementPrice = settleN > 0 ? settleSum / settleN : null
  stats.avgHoldingTimeSec = holdN > 0 ? holdSum / holdN : null
  stats.maxDrawdownPct = firstBalance !== null ? maxDrawdownPct : null
  stats.roiPct =
    firstBalance !== null && firstBalance > 0 && lastBalance !== null
      ? ((lastBalance - firstBalance) / firstBalance) * 100
      : null
  return stats
}

export interface ComparisonResult {
  a: ProfileStats
  b: ProfileStats
  /** Metric key → "a" | "b" | "tie" for UI highlighting. */
  winners: Record<string, "a" | "b" | "tie">
  recommendation: string
}

const HIGHER_IS_BETTER: Array<keyof ProfileStats> = [
  "winRate",
  "roiPct",
  "netProfitUsd",
  "profitFactor",
  "largestWinUsd",
  "longestWinStreak",
  "avgSettlementPrice",
]
const LOWER_IS_BETTER: Array<keyof ProfileStats> = ["grossLossUsd", "maxDrawdownPct", "longestLossStreak"]

/** Read-only A/B comparison. Never changes any strategy. */
export function compareProfiles(nameA: string, nameB: string): ComparisonResult {
  const a = computeProfileStats(nameA)
  const b = computeProfileStats(nameB)
  const winners: Record<string, "a" | "b" | "tie"> = {}

  const pick = (key: keyof ProfileStats, higherBetter: boolean) => {
    const va = a[key]
    const vb = b[key]
    if (typeof va !== "number" || typeof vb !== "number" || Number.isNaN(va) || Number.isNaN(vb)) {
      winners[key] = "tie"
      return
    }
    if (va === vb) winners[key] = "tie"
    else if (higherBetter) winners[key] = va > vb ? "a" : "b"
    else winners[key] = va < vb ? "a" : "b"
  }
  for (const k of HIGHER_IS_BETTER) pick(k, true)
  for (const k of LOWER_IS_BETTER) pick(k, false)

  let recommendation: string
  if (a.totalTrades === 0 && b.totalTrades === 0) {
    recommendation = "Neither profile has attributed trades yet. Load a profile, run sessions, and compare again."
  } else if (a.totalTrades === 0) {
    recommendation = `Only "${b.profileName}" has trade history (${b.totalTrades} trades). No basis for comparison yet.`
  } else if (b.totalTrades === 0) {
    recommendation = `Only "${a.profileName}" has trade history (${a.totalTrades} trades). No basis for comparison yet.`
  } else {
    const score = (s: ProfileStats) =>
      (Number.isFinite(s.profitFactor) ? Math.min(s.profitFactor, 10) : 10) * 2 +
      s.winRate / 25 +
      (s.roiPct ?? 0) / 10 -
      (s.maxDrawdownPct ?? 0) / 20
    const sa = score(a)
    const sb = score(b)
    const better = sa === sb ? null : sa > sb ? a : b
    const small = a.totalTrades < 30 || b.totalTrades < 30 ? " Sample sizes are small — treat this as directional only." : ""
    recommendation = better
      ? `"${better.profileName}" shows stronger risk-adjusted performance (PF ${Number.isFinite(better.profitFactor) ? better.profitFactor.toFixed(2) : "∞"}, ` +
        `win rate ${better.winRate.toFixed(1)}%, drawdown ${(better.maxDrawdownPct ?? 0).toFixed(1)}%).${small} This is analysis only — no strategy has been changed.`
      : `The profiles are statistically even on this sample.${small} This is analysis only — no strategy has been changed.`
  }

  return { a, b, winners, recommendation }
}
