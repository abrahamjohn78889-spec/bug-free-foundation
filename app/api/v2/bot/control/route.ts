import { NextResponse } from "next/server"
import { checkControlAuth } from "@/lib/v2/engine/api-auth"
import { getEngine } from "@/lib/v2/engine/engine"
import { isStrategyId } from "@/lib/v2/engine/strategy-registry/registry"
import type { PipelineMode, SloSizingMode, StrategyId, StrategyParams, TIF, TriggerMode } from "@/lib/v2/engine/types"

export const dynamic = "force-dynamic"

interface ControlBody {
  action:
    | "start"
    | "stop"
    | "set_mode"
    | "set_balance"
    | "set_bands"
    | "set_drift"
    | "set_tif"
    | "set_p1_window"
    | "set_price_range"
    | "set_strategy"
    | "set_strategy_params"
    | "set_limit_order"
    | "clear_limit_order"
    | "pause_limit_order"
    | "resume_limit_order"
    | "reset_ledger"
    | "kill_switch_engage"
    | "kill_switch_disengage"
    | "set_risk_limits"
  mode?: PipelineMode
  /** kill_switch_engage: optional operator note recorded with the stop. */
  reason?: string
  /** set_risk_limits fields (all optional; only provided values change). */
  maxDailyLossUsd?: number
  maxOrderNotionalUsd?: number
  maxDailyOrders?: number
  maxSharesPerOrder?: number
  amount?: number
  p1?: { min: number; max: number }
  p2?: { min: number; max: number }
  driftUsd?: number
  tif?: TIF
  p1WindowMs?: number
  priceFloor?: number
  priceCeil?: number
  strategy?: StrategyId | null
  params?: StrategyParams
  /** Standing limit order fields (majority side auto-detected, trigger is user-defined) */
  limitPrice?: number
  limitShares?: number
  minPrice?: number
  maxPrice?: number
  triggerPrice?: number
  /** Optional trigger mode; defaults to UPWARD_CROSSING in the engine when omitted. */
  triggerMode?: TriggerMode
  /** Position sizing model; defaults to FIXED_SHARES (legacy) when omitted. */
  sizingMode?: SloSizingMode
  /** Share count | dollar amount | percent of pool, per sizingMode. */
  sizeValue?: number
  /** FINAL entry window in SECONDS before settlement; null/0/omitted = disabled. */
  entryWindowSec?: number | null
}

/** Reject NaN/Infinity — JSON.parse can't produce them, but belt-and-braces
 *  against proxies or future body sources. Returns undefined for non-finite. */
function finite(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined
}

export async function POST(req: Request) {
  try {
    // Opt-in shared-secret auth (BOT_CONTROL_TOKEN). No-op when unset.
    const auth = checkControlAuth(req)
    if (!auth.ok) {
      return NextResponse.json({ ok: false, message: auth.message }, { status: 401 })
    }

    const engine = getEngine()
    let body: ControlBody
    try {
      body = (await req.json()) as ControlBody
    } catch {
      return NextResponse.json({ ok: false, message: "Invalid JSON" }, { status: 400 })
    }

    let message = "Unknown action"
    switch (body.action) {
    case "start":
      try {
        message = engine.start()
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        console.error("[control] START failed:", err)
        return NextResponse.json({ ok: false, message: `Start failed: ${err}` }, { status: 400 })
      }
      break
    case "stop":
      message = engine.stop()
      break
    case "set_mode":
      // Exactly two pipelines share one engine: PAPER_V1 (simulated execution
      // against live CLOB data) and LIVE_V2 (real money). The only difference
      // is the execution backend — everything upstream is identical.
      if (body.mode !== "PAPER_V1" && body.mode !== "LIVE_V2") {
        return NextResponse.json(
          { ok: false, message: "Pipeline must be PAPER_V1 or LIVE_V2." },
          { status: 400 },
        )
      }
      message = engine.setMode(body.mode)
      break
    case "set_balance":
      if (typeof body.amount === "number") message = engine.setPaperBalance(body.amount)
      else return NextResponse.json({ ok: false, message: "amount required" }, { status: 400 })
      break
    case "set_bands":
      message = engine.setBands(body.p1 ?? null, body.p2 ?? null)
      break
    case "set_drift":
      if (typeof body.driftUsd === "number") message = engine.setDriftPadding(body.driftUsd)
      else return NextResponse.json({ ok: false, message: "driftUsd required" }, { status: 400 })
      break
    case "set_tif":
      if (body.tif === "1m" || body.tif === "2m" || body.tif === "GTC") message = engine.setTif(body.tif)
      else return NextResponse.json({ ok: false, message: "tif must be 1m, 2m, or GTC" }, { status: 400 })
      break
    case "set_p1_window":
      if (typeof body.p1WindowMs === "number") message = engine.setP1Window(body.p1WindowMs)
      else return NextResponse.json({ ok: false, message: "p1WindowMs required" }, { status: 400 })
      break
    case "set_price_range":
      if (typeof body.priceFloor === "number" && typeof body.priceCeil === "number")
        message = engine.setPriceRange(body.priceFloor, body.priceCeil)
      else return NextResponse.json({ ok: false, message: "priceFloor and priceCeil required" }, { status: 400 })
      break
    case "set_strategy":
      if (body.strategy === null || isStrategyId(body.strategy)) message = engine.setStrategy(body.strategy)
      else return NextResponse.json({ ok: false, message: "strategy must be a valid id or null" }, { status: 400 })
      break
    case "set_strategy_params":
      if (isStrategyId(body.strategy) && body.params && typeof body.params === "object")
        message = engine.setStrategyParams(body.strategy, body.params)
      else return NextResponse.json({ ok: false, message: "strategy id and params required" }, { status: 400 })
      break
    case "set_limit_order": {
      const limitPrice = finite(body.limitPrice)
      const limitShares = finite(body.limitShares)
      const minPrice = finite(body.minPrice)
      const maxPrice = finite(body.maxPrice)
      const triggerPrice = finite(body.triggerPrice)
      if (limitPrice === undefined || limitShares === undefined) {
        return NextResponse.json(
          { ok: false, message: "limitPrice and limitShares must be finite numbers" },
          { status: 400 },
        )
      }
      if (
        body.triggerMode !== undefined &&
        body.triggerMode !== "UPWARD_CROSSING" &&
        body.triggerMode !== "AT_OR_ABOVE"
      ) {
        return NextResponse.json(
          { ok: false, message: "triggerMode must be UPWARD_CROSSING or AT_OR_ABOVE" },
          { status: 400 },
        )
      }
      if (
        body.sizingMode !== undefined &&
        body.sizingMode !== "FIXED_SHARES" &&
        body.sizingMode !== "FIXED_USD" &&
        body.sizingMode !== "PERCENT"
      ) {
        return NextResponse.json(
          { ok: false, message: "sizingMode must be FIXED_SHARES, FIXED_USD, or PERCENT" },
          { status: 400 },
        )
      }
      const sizeValue = finite(body.sizeValue)
      const entryWindowSec =
        body.entryWindowSec === null || body.entryWindowSec === undefined ? null : finite(body.entryWindowSec) ?? null
      message = engine.setLimitOrder(limitPrice, limitShares, minPrice, maxPrice, triggerPrice, body.triggerMode, {
        sizingMode: body.sizingMode,
        sizeValue,
        entryWindowSec,
      })
      break
    }
    case "clear_limit_order":
      message = engine.clearLimitOrder()
      break
    case "pause_limit_order":
      message = engine.pauseLimitOrder()
      break
    case "resume_limit_order":
      message = engine.resumeLimitOrder()
      break
    case "reset_ledger":
      message = engine.resetLedger()
      break
    case "kill_switch_engage":
      message = engine.engageKillSwitch(typeof body.reason === "string" ? body.reason : undefined)
      break
    case "kill_switch_disengage":
      message = engine.disengageKillSwitch()
      break
    case "set_risk_limits":
      message = engine.setRiskLimits({
        maxDailyLossUsd: typeof body.maxDailyLossUsd === "number" ? body.maxDailyLossUsd : undefined,
        maxOrderNotionalUsd: typeof body.maxOrderNotionalUsd === "number" ? body.maxOrderNotionalUsd : undefined,
        maxDailyOrders: typeof body.maxDailyOrders === "number" ? body.maxDailyOrders : undefined,
        maxSharesPerOrder: typeof body.maxSharesPerOrder === "number" ? body.maxSharesPerOrder : undefined,
      })
      break
    default:
      return NextResponse.json({ ok: false, message }, { status: 400 })
    }

    return NextResponse.json({ ok: true, message })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error"
    console.error("[control] Control route error:", errorMsg, err)
    return NextResponse.json({ ok: false, message: `Server error: ${errorMsg}` }, { status: 500 })
  }
}
