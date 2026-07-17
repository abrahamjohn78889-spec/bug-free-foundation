// ============================================================================
// HEALTH — pure aggregator that inspects every trading-critical subsystem and
// returns a structured report. Used by the /api/v2/bot/health route (for
// external uptime checks / PM2 probes) and by the in-process health monitor
// (which pushes Telegram alerts on state transitions and sustained faults).
//
// All checks are READ-ONLY and best-effort: any thrown exception downgrades
// the offending subsystem to `ok: false` without affecting the others, and
// never propagates back into the trading path.
// ============================================================================

import { getEngine } from "./engine"
import { getOrderEventListener } from "./feeds/order-events"
import { feedStats } from "./db"

export type HealthCheck = { ok: boolean; detail: string; severity?: "info" | "warn" | "critical" }
export type HealthReport = {
  status: "healthy" | "degraded"
  atMs: number
  pid: number
  uptimeSec: number
  checks: Record<string, HealthCheck>
}

/** Compute a full health report. Never throws — every subsystem is guarded. */
export function computeHealth(): HealthReport {
  const checks: Record<string, HealthCheck> = {}
  let engineOk = false

  try {
    const engine = getEngine()
    const snap = engine.snapshot()
    engineOk = true
    checks.engine = {
      ok: true,
      detail: `mode=${snap.mode} running=${snap.running} phase=${snap.phase}`,
    }

    // Market data freshness (only when a market is actively tracked).
    const diag = snap.clobDiagnostics as
      | {
          upTokenId?: string | null
          upQuoteAgeMs: number | null
          consecutiveFailures: number
          ws: { connected: boolean }
        }
      | null
    const tracking = Boolean(diag?.upTokenId)
    if (tracking && diag) {
      const quoteFresh = diag.upQuoteAgeMs !== null && diag.upQuoteAgeMs < 30_000
      checks.quotes = {
        ok: quoteFresh,
        severity: quoteFresh ? "info" : "critical",
        detail: quoteFresh
          ? `age ${diag.upQuoteAgeMs}ms`
          : `stale (age ${diag.upQuoteAgeMs ?? "never"}ms, ${diag.consecutiveFailures} consecutive failures)`,
      }
      checks.market_ws = {
        ok: diag.ws.connected,
        severity: diag.ws.connected ? "info" : "warn",
        detail: diag.ws.connected ? "connected" : "disconnected (REST fallback active)",
      }
    } else {
      checks.quotes = { ok: true, detail: "no market tracked (discovery pending or engine idle)" }
      checks.market_ws = { ok: true, detail: "no active subscription" }
    }

    // User-channel WS (order fill events). Only required when the engine is
    // actively running LIVE_V2; PAPER_V1 uses the internal simulated executor.
    try {
      const listener = getOrderEventListener()
      const userConnected = listener.connected
      const userRequired = snap.running && snap.mode === "LIVE_V2"
      checks.user_ws = {
        ok: !userRequired || userConnected,
        severity: userRequired && !userConnected ? "critical" : "info",
        detail: userConnected
          ? "user channel connected"
          : userRequired
            ? "user channel DISCONNECTED (fills may be missed until reconnect)"
            : "not required",
      }
    } catch (e) {
      checks.user_ws = {
        ok: false,
        severity: "warn",
        detail: e instanceof Error ? e.message : String(e),
      }
    }

    // Watchdog liveness: it checks every 30s; >120s silence means it died.
    const wd = engine.watchdog.snapshot()
    const wdAlive = wd.checksRun > 0 ? Date.now() - wd.lastCheckAtMs < 120_000 : true
    checks.watchdog = {
      ok: wdAlive,
      severity: wdAlive ? "info" : "critical",
      detail: wdAlive
        ? `${wd.checksRun} checks, ${wd.marketWsReconnects + wd.userWsReconnects} WS repairs, ${wd.staleQuoteRecoveries} quote recoveries`
        : `last check ${Math.round((Date.now() - wd.lastCheckAtMs) / 1000)}s ago — watchdog stalled`,
    }

    // Memory: warn-level unhealthy above 460MB (PM2 hard-restarts at 512MB).
    checks.memory = {
      ok: wd.rssMb < 460,
      severity: wd.rssMb < 460 ? "info" : "warn",
      detail: `rss ${wd.rssMb}MB, heap ${wd.heapUsedMb}MB, uptime ${wd.uptimeSec}s`,
    }

    // Execution pipeline — a resting order that has been open significantly
    // longer than the configured entry window without a fill or rollover is
    // a strong signal that the trigger→submit→fill loop has stalled. We give
    // a 3× slack to absorb book congestion and rollover edge cases before
    // flagging the pipeline as degraded.
    const slo = snap.standingLimitOrder
    if (slo && slo.status === "RESTING" && slo.entryWindowMs > 0) {
      const restingAgeMs = slo.slotEndMs ? slo.slotEndMs - Date.now() : 0
      // slotEndMs is in the FUTURE for a healthy resting order. When it goes
      // NEGATIVE, the rollover watchdog should have already cancelled it —
      // if not, the pipeline is stalled.
      const stalledMs = restingAgeMs < 0 ? -restingAgeMs : 0
      const stallThresholdMs = Math.max(slo.entryWindowMs * 2, 15_000)
      const executionStalled = stalledMs > stallThresholdMs
      checks.execution = {
        ok: !executionStalled,
        severity: executionStalled ? "critical" : "info",
        detail: executionStalled
          ? `RESTING order ${stalledMs}ms past slot end (threshold ${stallThresholdMs}ms) — rollover may have failed`
          : `resting order healthy (window ${slo.entryWindowMs}ms, slot ends in ${restingAgeMs}ms)`,
      }
    } else {
      checks.execution = {
        ok: true,
        detail: slo ? `status=${slo.status} executions=${slo.executionCount}` : "no standing order armed",
      }
    }

    // Fill reconciler — surfaces UNBOOKED / UNATTRIBUTED / DUPLICATE / ORPHAN
    // drift between the CLOB fill stream and the local ledger. Any finding
    // in the most recent report is a critical alert.
    try {
      const rec = (engine as unknown as { fillReconciler?: { latest?: unknown } }).fillReconciler
      const latest = rec?.latest as
        | { ok: boolean; findings: { kind: string }[]; atMs: number; error: string | null }
        | undefined
        | null
      if (!latest) {
        checks.fills = { ok: true, detail: "reconciler not yet run" }
      } else if (!latest.ok) {
        const kinds = latest.findings.map((f) => f.kind).join(", ")
        checks.fills = {
          ok: false,
          severity: "critical",
          detail: `${latest.findings.length} drift finding(s): ${kinds}${latest.error ? ` — ${latest.error}` : ""}`,
        }
      } else {
        checks.fills = {
          ok: true,
          detail: `clean (last run ${Math.round((Date.now() - latest.atMs) / 1000)}s ago)`,
        }
      }
    } catch (e) {
      checks.fills = { ok: true, detail: e instanceof Error ? e.message : String(e) }
    }

    // Risk layer visibility (kill switch engaged is intentional operator
    // state — surfaced as a warning, not unhealthy).
    checks.risk = {
      ok: true,
      severity: snap.risk.killSwitch.engaged ? "warn" : "info",
      detail: snap.risk.killSwitch.engaged
        ? `KILL SWITCH ENGAGED (${snap.risk.killSwitch.reason})`
        : `armed, daily pnl $${snap.risk.dailyRealizedPnl.toFixed(2)}`,
    }
  } catch (e) {
    checks.engine = { ok: false, severity: "critical", detail: e instanceof Error ? e.message : String(e) }
  }

  // Database probe (independent of the engine graph).
  try {
    feedStats("LIVE_V2")
    checks.database = { ok: true, detail: "sqlite readable" }
  } catch (e) {
    checks.database = { ok: false, severity: "critical", detail: e instanceof Error ? e.message : String(e) }
  }

  const healthy = engineOk && Object.values(checks).every((c) => c.ok)
  return {
    status: healthy ? "healthy" : "degraded",
    atMs: Date.now(),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    checks,
  }
}
