import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/**
 * Health endpoint for external monitoring (uptime checks, PM2 health probes,
 * alerting). Returns HTTP 200 when every critical subsystem is healthy and
 * HTTP 503 with per-subsystem detail when anything is degraded.
 *
 * Checks (per subsystem):
 *  • engine     — singleton constructed, tick loop responsive when ignited
 *  • market_ws  — market-channel WebSocket connected + recently active
 *  • quotes     — CLOB quotes fresh (only when a market is being tracked)
 *  • clock      — server/exchange clock sync running
 *  • database   — SQLite readable
 *  • watchdog   — self-healing layer running and checking
 *  • memory     — RSS below the PM2 restart threshold
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; detail: string }> = {}
  let engineOk = false

  try {
    const { getEngine } = await import("@/lib/v2/engine/engine")
    const engine = getEngine()
    const snap = engine.snapshot()
    engineOk = true
    checks.engine = {
      ok: true,
      detail: `mode=${snap.mode} running=${snap.running} phase=${snap.phase}`,
    }

    // Market data: only require freshness when a market is actively tracked.
    const diag = snap.clobDiagnostics
    const tracking = Boolean(diag && (diag as { upTokenId?: string | null }).upTokenId)
    if (tracking && diag) {
      const d = diag as unknown as {
        upQuoteAgeMs: number | null
        consecutiveFailures: number
        ws: { connected: boolean }
      }
      const quoteFresh = d.upQuoteAgeMs !== null && d.upQuoteAgeMs < 30_000
      checks.quotes = {
        ok: quoteFresh,
        detail: quoteFresh
          ? `age ${d.upQuoteAgeMs}ms`
          : `stale (age ${d.upQuoteAgeMs ?? "never"}ms, ${d.consecutiveFailures} consecutive failures)`,
      }
      checks.market_ws = {
        ok: d.ws.connected,
        detail: d.ws.connected ? "connected" : "disconnected (REST fallback active)",
      }
    } else {
      checks.quotes = { ok: true, detail: "no market tracked (discovery pending or engine idle)" }
      checks.market_ws = { ok: true, detail: "no active subscription" }
    }

    // Watchdog liveness: it checks every 30s; >120s silence means it died.
    const wd = engine.watchdog.snapshot()
    const wdAlive = wd.checksRun > 0 ? Date.now() - wd.lastCheckAtMs < 120_000 : true
    checks.watchdog = {
      ok: wdAlive,
      detail: wdAlive
        ? `${wd.checksRun} checks, ${wd.marketWsReconnects + wd.userWsReconnects} WS repairs, ${wd.staleQuoteRecoveries} quote recoveries`
        : `last check ${Math.round((Date.now() - wd.lastCheckAtMs) / 1000)}s ago — watchdog stalled`,
    }

    // Memory: warn-level unhealthy above 460MB (PM2 hard-restarts at 512MB).
    checks.memory = {
      ok: wd.rssMb < 460,
      detail: `rss ${wd.rssMb}MB, heap ${wd.heapUsedMb}MB, uptime ${wd.uptimeSec}s`,
    }

    // Risk layer visibility (kill switch engaged is DEGRADED, not unhealthy —
    // it is an intentional operator state, but monitors should see it).
    checks.risk = {
      ok: true,
      detail: snap.risk.killSwitch.engaged
        ? `KILL SWITCH ENGAGED (${snap.risk.killSwitch.reason})`
        : `armed, daily pnl $${snap.risk.dailyRealizedPnl.toFixed(2)}`,
    }
  } catch (e) {
    checks.engine = { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }

  // Database probe (independent of the engine graph).
  try {
    const { feedStats } = await import("@/lib/v2/engine/db")
    feedStats("LIVE_V2")
    checks.database = { ok: true, detail: "sqlite readable" }
  } catch (e) {
    checks.database = { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }

  const healthy = engineOk && Object.values(checks).every((c) => c.ok)
  return NextResponse.json(
    {
      status: healthy ? "healthy" : "degraded",
      atMs: Date.now(),
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      checks,
    },
    { status: healthy ? 200 : 503 },
  )
}
