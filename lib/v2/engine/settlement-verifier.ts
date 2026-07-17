/**
 * Post-settlement verification — the safety net behind the settlement path.
 *
 * Every settled trade (INCLUDING SCRATCH) is re-checked against the OFFICIAL
 * Polymarket resolution once it becomes available. Phase 4 upgraded this
 * module from alert-only to alert + audited AUTO-REPAIR:
 *
 *   1. Verifies the result label AND the recomputed PnL AND the settlement
 *      source (spot-fallback / scratch settles are re-checked with priority).
 *   2. On mismatch with official evidence: CRITICAL log + permanent
 *      order_log row + Telegram (as before) **and then an audited, atomic,
 *      idempotent repair** via settlement-repair.ts — result, PnL, bankroll,
 *      and wallet mirror are corrected with a permanent evidence trail.
 *   3. SCRATCH trades booked while the official result was unavailable
 *      (restart-orphan recovery, resolution timeouts) are UPGRADED to their
 *      true WIN/LOSS once the resolution is published — this eliminates the
 *      "excessive SCRATCH" ledger distortion.
 *   4. A balance-chain audit walks the settled ledger chronologically and
 *      raises CRITICAL when `balance_after` deltas don't equal the booked
 *      PnL pattern (report-only: chain breaks have no single-row fix).
 *
 * Repairs are driven ONLY by the official resolution — spot prices and
 * majority heuristics can never rewrite a booked trade. The kv marker inside
 * repairTrade guarantees a trade can never be repaired twice (no
 * double-credit), even across restarts.
 *
 * Forensic origin: trade ecac0be7 (btc-updown-5m-1783949100) was booked
 * LOSS -$10.89 via spot-fallback while the official Chainlink resolution
 * was DOWN (a WIN). The Gamma closed-market query bug meant the official
 * outcome was structurally unreachable, and nothing ever re-checked the
 * booked result. This verifier closes that gap permanently.
 */

import { fetchOfficialResolution } from "./feeds/market-discovery"
import { recentTrades, insertOrderLog, kvGet, kvSet } from "./db"
import { repairTrade } from "./settlement-repair"
import { logEvent } from "./events"
import { notify } from "./notifier"
import type { PipelineMode, TradeSide, SettledTrade } from "./types"

/** Verification runs at most this often. */
const VERIFY_INTERVAL_MS = 60_000
/** Only verify trades settled at least this long ago (resolution needs ~30s). */
const MIN_AGE_MS = 90_000
/** Re-check window: verify trades settled within the last 48 h. */
const MAX_AGE_MS = 48 * 3600_000
/** Max trades fetched per sweep. */
const SWEEP_LIMIT = 100
/** Max Gamma lookups per sweep (rate-limit safety). */
const MAX_LOOKUPS_PER_SWEEP = 10

const kvKey = (tradeUid: string) => `verify:settle:${tradeUid}`

export interface VerificationOutcome {
  checked: number
  verified: number
  mismatches: number
  repairs: number
  pending: number
  balanceChainBreaks: number
}

/** Cumulative counters for the dashboard/status surface. */
export interface VerifierStats {
  sweeps: number
  verified: number
  mismatches: number
  repairs: number
  balanceChainBreaks: number
  lastSweepAtMs: number
}

const stats: VerifierStats = { sweeps: 0, verified: 0, mismatches: 0, repairs: 0, balanceChainBreaks: 0, lastSweepAtMs: 0 }

export function verifierStats(): VerifierStats {
  return { ...stats }
}

/** Extract the recorded resolution source from the trade's explanation JSON. */
function resolutionSourceOf(t: SettledTrade): string {
  if (!t.explanation) return "unknown"
  try {
    const parsed = JSON.parse(t.explanation) as Record<string, unknown>
    return typeof parsed.resolutionSource === "string" ? parsed.resolutionSource : "unknown"
  } catch {
    return "unknown"
  }
}

/** True when a settle came from a non-authoritative source needing priority re-check. */
function isSoftSettled(t: SettledTrade): boolean {
  const src = resolutionSourceOf(t)
  return t.result === "SCRATCH" || src === "spot-fallback" || src === "scratch" || src === "orphan-recovery"
}

/** The correct booked PnL for a result (mirror of recordSettlement's math). */
function expectedPnlFor(t: SettledTrade, official: TradeSide): number {
  const won = t.side === official
  const payout = won ? t.shares : 0
  return Math.round((payout - t.cost) * 10000) / 10000
}

/**
 * One verification sweep. Exported for tests and for the interval runner.
 * Idempotent per trade: each trade_uid is checked until the official
 * resolution is available, then permanently marked verified — or repaired.
 */
export async function verifySettlements(
  mode: PipelineMode,
  opts?: { creditWallet?: (usdDelta: number) => void },
): Promise<VerificationOutcome> {
  const out: VerificationOutcome = { checked: 0, verified: 0, mismatches: 0, repairs: 0, pending: 0, balanceChainBreaks: 0 }
  const now = Date.now()
  let lookups = 0

  const all = recentTrades(mode, SWEEP_LIMIT)
  const candidates = all.filter((t) => {
    if (t.status !== "SETTLED" || !t.tradeUid) return false
    const settledMs = t.settledAt ? Date.parse(t.settledAt + "Z") : NaN
    if (!Number.isFinite(settledMs)) return true // no timestamp — verify anyway
    const age = now - settledMs
    return age >= MIN_AGE_MS && age <= MAX_AGE_MS
  })

  // PRIORITY ORDER: soft-settled trades (SCRATCH / spot-fallback) first —
  // these are the ones most likely to disagree with the official result.
  const trades = [...candidates].sort((a, b) => Number(isSoftSettled(b)) - Number(isSoftSettled(a)))

  for (const t of trades) {
    if (lookups >= MAX_LOOKUPS_PER_SWEEP) break
    const uid = t.tradeUid as string
    const existing = kvGet(kvKey(uid))
    if (existing === "ok" || existing?.startsWith("repaired")) continue
    // Legacy "mismatch:*" markers (pre-repair era) are RE-processed so the
    // new repair path can fix trades the old verifier could only flag.

    lookups++
    out.checked++
    const official: TradeSide | null = await fetchOfficialResolution(t.slotEndMs)
    if (official === null) {
      out.pending++ // resolution not yet published — retry next sweep
      continue
    }

    const correctResult = t.side === official ? "WIN" : "LOSS"
    const correctPnl = expectedPnlFor(t, official)
    const resultOk = t.result === correctResult
    // PnL check: label can be right while the math is wrong.
    const pnlOk = resultOk && Math.abs(t.pnl - correctPnl) < 0.005

    if (resultOk && pnlOk) {
      kvSet(kvKey(uid), "ok")
      out.verified++
      stats.verified++
      continue
    }

    // ---- MISMATCH: alert (never silently continue), then REPAIR. ----
    out.mismatches++
    stats.mismatches++
    const src = resolutionSourceOf(t)
    const detail =
      `SETTLEMENT MISMATCH trade_uid=${uid} ledger=${t.result} official_winner=${official} ` +
      `correct=${correctResult} bet=${t.side} shares=${t.shares} cost=$${t.cost.toFixed(4)} ` +
      `booked_pnl=$${t.pnl.toFixed(4)} correct_pnl=$${correctPnl.toFixed(4)} source=${src}`

    logEvent("error", `[settlement-verifier] CRITICAL: ${detail} — applying audited auto-repair`)
    insertOrderLog({
      mode,
      event: "ERROR",
      marketId: t.marketId,
      side: t.side,
      price: t.price,
      shares: t.shares,
      detail: `SETTLEMENT_MISMATCH ${detail}`,
    })
    notify(
      "errors",
      "CRITICAL: settlement mismatch",
      `${t.marketId}\nLedger: ${t.result} → Official: ${correctResult} (winner ${official})\nTrade ${uid.slice(0, 8)} | ${t.shares} shares @ $${t.price.toFixed(2)}\nAudited auto-repair in progress.`,
    )

    const repair = repairTrade(
      {
        id: t.id,
        tradeUid: t.tradeUid,
        marketId: t.marketId,
        slotEndMs: t.slotEndMs,
        side: t.side,
        price: t.price,
        shares: t.shares,
        cost: t.cost,
        result: t.result as "WIN" | "LOSS" | "SCRATCH",
        pnl: t.pnl,
        mode,
      },
      official,
      { requestedBy: "settlement-verifier", creditWallet: opts?.creditWallet },
    )
    if (repair.applied) {
      out.repairs++
      stats.repairs++
      kvSet(kvKey(uid), `repaired:${t.result}->${correctResult}`)
    } else {
      // Repair refused (already repaired / row gone) — permanent mismatch mark.
      kvSet(kvKey(uid), `mismatch:${t.result}->${correctResult}:${repair.reason}`)
      logEvent("warn", `[settlement-verifier] repair not applied for ${uid}: ${repair.reason}`)
    }
  }

  // ---- Balance-chain audit (report-only). ----
  out.balanceChainBreaks = auditBalanceChain(mode, all)
  stats.balanceChainBreaks += out.balanceChainBreaks
  stats.sweeps++
  stats.lastSweepAtMs = now

  return out
}

/**
 * Walk the settled ledger chronologically and verify the running balance is
 * self-consistent: each settled row's `balance_after` should differ from the
 * previous settled row's by (payout of this row − cost of this row) — i.e.
 * by the row's PnL — modulo rows settled before the previous row's stamp.
 *
 * Report-only: a chain break means some historical write was wrong or a
 * balance was reset mid-history; there is no single-row fix, so it raises
 * CRITICAL for operator attention instead of guessing.
 *
 * Throttled: each break is reported once per process lifetime (kv-less,
 * in-memory) to avoid alert storms on an old broken chain.
 */
const reportedBreaks = new Set<string>()

function auditBalanceChain(mode: PipelineMode, trades: SettledTrade[]): number {
  // recentTrades returns newest-first; walk oldest-first, settled rows only.
  // Repaired rows are excluded: a repair corrects result/pnl and stamps the
  // CURRENT pool balance, which legitimately breaks the historical chain at
  // that row (the neighboring stamps were written against the old balance).
  const settled = trades
    .filter((t) => t.status === "SETTLED" && !(t.explanation ?? "").includes("settlementRepair"))
    .sort((a, b) => a.id - b.id)
  let breaks = 0
  for (let i = 1; i < settled.length; i++) {
    const prev = settled[i - 1]
    const cur = settled[i]
    // Expected: balance_after[i] = balance_after[i-1] − cost[i] + payout[i]
    // (cost was debited at fill; payout credited at settle; balance_after is
    // stamped post-settle). SCRATCH: payout = cost → delta 0. WIN: delta =
    // shares − cost = pnl. LOSS: delta = −cost = pnl. So delta always = pnl.
    const expectedDelta = cur.pnl
    const actualDelta = Math.round((cur.balanceAfter - prev.balanceAfter) * 10000) / 10000
    if (Math.abs(actualDelta - expectedDelta) > 0.01) {
      breaks++
      const key = `${mode}:${cur.id}`
      if (!reportedBreaks.has(key)) {
        reportedBreaks.add(key)
        logEvent(
          "error",
          `[settlement-verifier] CRITICAL balance-chain break at trade #${cur.id} (${cur.marketId}): ` +
            `balance moved ${actualDelta >= 0 ? "+" : ""}$${actualDelta.toFixed(4)} but booked PnL is ` +
            `${expectedDelta >= 0 ? "+" : ""}$${expectedDelta.toFixed(4)} — the running balance does not reconcile with the ledger (report-only, no auto-fix)`,
        )
      }
    }
  }
  return breaks
}

let timer: ReturnType<typeof setInterval> | null = null

/** Idempotent background runner — safe to call from multiple start paths. */
export function startSettlementVerifier(getMode: () => PipelineMode, opts?: { creditWallet?: (usdDelta: number) => void }): void {
  if (timer) return
  timer = setInterval(() => {
    void verifySettlements(getMode(), opts).catch((e) =>
      logEvent("warn", `[settlement-verifier] sweep failed: ${e instanceof Error ? e.message : String(e)}`),
    )
  }, VERIFY_INTERVAL_MS)
  // Node-only: never keep the process alive for the verifier.
  if (typeof timer === "object" && "unref" in timer) timer.unref()
  logEvent(
    "info",
    "[settlement-verifier] started — every settled trade (incl. SCRATCH) is re-checked against the official Polymarket resolution and auto-repaired with audited evidence on mismatch",
  )
}

export function stopSettlementVerifier(): void {
  if (timer) clearInterval(timer)
  timer = null
}
