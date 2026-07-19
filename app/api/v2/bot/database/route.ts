import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/**
 * GET  /api/v2/bot/database            → stats (sizes, row counts, backups)
 * GET  /api/v2/bot/database?export=csv|json → full trade export for the active mode
 * POST /api/v2/bot/database { action: "backup" | "integrity" } → run a tool
 * Auth: dashboard session middleware (proxy.ts) gates all /api/v2 routes.
 */
export async function GET(req: Request) {
  try {
    const [{ dbStats, exportTrades }, { getEngine }] = await Promise.all([
      import("@/lib/v2/engine/db"),
      import("@/lib/v2/engine/engine"),
    ])
    const url = new URL(req.url)
    const exportFmt = url.searchParams.get("export")

    if (exportFmt === "csv" || exportFmt === "json") {
      const mode = getEngine().mode
      const rows = exportTrades(mode)
      const stamp = new Date().toISOString().slice(0, 10)
      if (exportFmt === "json") {
        return new NextResponse(JSON.stringify(rows, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="edge5-trades-${mode}-${stamp}.json"`,
          },
        })
      }
      // CSV: header from the union of keys, values escaped per RFC 4180.
      const cols = rows.length > 0 ? Object.keys(rows[0]) : []
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? "" : String(v)
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }
      const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n")
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="edge5-trades-${mode}-${stamp}.csv"`,
        },
      })
    }

    return NextResponse.json(dbStats(false))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: "DB_STATS_FAILED", message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const { checkRateLimit, callerKeyFromRequest, RATE_LIMITS } = await import("@/lib/v2/engine/rate-limit")
    const rl = checkRateLimit(RATE_LIMITS.database, callerKeyFromRequest(req))
    if (!rl.ok) return NextResponse.json(
      { ok: false, message: `Rate limit exceeded — retry in ${rl.retryAfterSec}s` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    )
    const { checkControlAuth } = await import("@/lib/v2/engine/api-auth")
    const auth = checkControlAuth(req)
    if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED", message: auth.message }, { status: 401 })
    const { dbStats, backupDatabase, integrityCheck } = await import("@/lib/v2/engine/db")
    const { logEvent } = await import("@/lib/v2/engine/events")
    const body = (await req.json().catch(() => ({}))) as { action?: string }

    if (body.action === "backup") {
      const file = backupDatabase(7)
      logEvent("info", `Manual database backup created: ${file}`, "system")
      return NextResponse.json({ ok: true, file, stats: dbStats(false) })
    }
    if (body.action === "integrity") {
      const result = integrityCheck()
      logEvent(result === "ok" ? "info" : "error", `Database integrity check: ${result}`, "system")
      return NextResponse.json({ ok: result === "ok", result, stats: dbStats(false) })
    }
    return NextResponse.json({ error: "UNKNOWN_ACTION" }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: "DB_ACTION_FAILED", message }, { status: 500 })
  }
}
