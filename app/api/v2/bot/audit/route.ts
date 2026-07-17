import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/**
 * GET /api/v2/bot/audit — structured audit log with filtering + search.
 *   ?category=orders&level=error&search=fill&since=86400000&limit=200
 *   ?download=1 → text/plain attachment of the filtered result.
 * Auth: dashboard session middleware (proxy.ts) gates all /api/v2 routes.
 */
export async function GET(req: Request) {
  try {
    const { queryAuditLog, auditCategories } = await import("@/lib/v2/engine/db")
    const url = new URL(req.url)
    const category = url.searchParams.get("category")
    const level = url.searchParams.get("level")
    const search = url.searchParams.get("search")
    const sinceParam = Number(url.searchParams.get("since") ?? Number.NaN)
    const sinceMs = Number.isFinite(sinceParam) && sinceParam > 0 ? Date.now() - sinceParam : null
    const limitParam = Number(url.searchParams.get("limit") ?? Number.NaN)
    const limit = Number.isFinite(limitParam) ? limitParam : 200

    const rows = queryAuditLog({ category, level, search, sinceMs, limit })

    if (url.searchParams.get("download") === "1") {
      const text = rows
        .map((r) => `${new Date(r.tsMs).toISOString()} [${r.level.toUpperCase()}] [${r.category}] ${r.message}`)
        .join("\n")
      return new NextResponse(text, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="edge5-audit-${new Date().toISOString().slice(0, 10)}.log"`,
        },
      })
    }

    return NextResponse.json({ rows, categories: auditCategories() })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: "AUDIT_QUERY_FAILED", message }, { status: 500 })
  }
}
