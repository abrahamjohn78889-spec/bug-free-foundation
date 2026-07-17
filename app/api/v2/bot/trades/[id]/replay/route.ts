import { NextResponse } from "next/server"
import { getDbHandle } from "@/lib/v2/engine/db"
import { buildTradeReplay } from "@/lib/v2/engine/trade-replay"

export const dynamic = "force-dynamic"

/**
 * Forensic replay for one trade: the full stored evidence bundle
 * (trade row, explanation/feedAudit, order-log chain, audit lines,
 * sibling trades) plus the direction VERDICT. Read-only.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const tradeId = Number(id)
  if (!Number.isFinite(tradeId) || tradeId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid trade id" }, { status: 400 })
  }
  try {
    const bundle = buildTradeReplay(getDbHandle(), tradeId)
    return NextResponse.json({ ok: true, replay: bundle })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 404 })
  }
}
