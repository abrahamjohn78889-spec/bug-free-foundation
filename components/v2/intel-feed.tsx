"use client"

import type { EngineSnapshot, StandingLimitOrder } from "@/lib/v2/engine/types"

interface Props {
  snap: EngineSnapshot
}

/** Top-line status banner. The Standing Limit Order is the primary engine, so
 *  its state leads whenever it is armed; otherwise we reflect engine power state. */
function statusOf(snap: EngineSnapshot): { label: string; tone: "green" | "orange" | "gray" } {
  if (!snap.running) return { label: "ENGINE OFFLINE — START TO BEGIN MONITORING", tone: "gray" }

  const sl = snap.standingLimitOrder
  if (sl) {
    const map: Record<StandingLimitOrder["status"], { label: string; tone: "green" | "orange" | "gray" }> = {
      ARMED: { label: "STANDING LIMIT ORDER ARMED — MONITORING MAJORITY SIDE", tone: "green" },
      TRIGGERED: { label: "TRIGGER REACHED — SUBMITTING LIMIT BUY", tone: "green" },
      RESTING: { label: "LIMIT BUY RESTING ON BOOK — AWAITING FILL", tone: "green" },
      FILLED: { label: "POSITION FILLED — HOLDING & MONITORING FOR NEXT ENTRY", tone: "green" },
      REFRESHING: { label: "SLOT ROLLOVER — RE-ARMING FOR NEW MARKET", tone: "orange" },
      WAITING_MARKET: { label: "WAITING FOR 5-MINUTE MARKET TO LIST", tone: "orange" },
      NO_DATA: { label: "NO LIVE POLYMARKET DATA — HOLDING (WILL NOT TRADE ON STALE PRICES)", tone: "orange" },
      OUT_OF_RANGE: { label: "MAJORITY PRICE OUTSIDE GUARDRAIL BAND", tone: "orange" },
      INSUFFICIENT: { label: "CAPITAL POOL TOO LOW FOR NEXT ENTRY", tone: "orange" },
      PAUSED: { label: "STANDING LIMIT ORDER PAUSED", tone: "orange" },
      BLOCKED: {
        label: sl.blockedReason
          ? `RISK GATE BLOCKING ORDERS — ${sl.blockedReason.toUpperCase()}`
          : "RISK GATE BLOCKING ORDERS — AUTO-RESUMES WHEN CLEARED",
        tone: "orange",
      },
      WINDOW_WAITING: {
        label: "MONITORING — FINAL ENTRY WINDOW OPENS BEFORE SETTLEMENT",
        tone: "orange",
      },
      WINDOW_EXPIRED: {
        label: "MARKET SETTLED BEFORE SUBMISSION — RE-ARMS ON THE NEXT 5-MIN MARKET",
        tone: "orange",
      },
      WAITING_SETTLE: {
        label: "WAITING FOR PRIOR SETTLEMENT TO CREDIT BEFORE NEXT ENTRY",
        tone: "orange",
      },
    }
    return map[sl.status] ?? { label: `STANDING LIMIT ORDER — ${sl.status}`, tone: "green" }
  }

  return { label: "ENGINE LIVE — NO STANDING LIMIT ORDER ARMED", tone: "orange" }
}

const money = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`

export function IntelFeed({ snap }: Props) {
  const status = statusOf(snap)
  const fs = snap.feedStats
  const decided = fs.wins + fs.losses
  const winRate = decided > 0 ? Math.round((fs.wins / decided) * 100) : 0

  const summary: { label: string; value: string; tone?: "neon" | "crimson" | "default" }[] = [
    { label: "Orders Submitted", value: String(fs.ordersSubmitted) },
    { label: "Orders Filled", value: String(fs.ordersFilled) },
    { label: "Shares Traded", value: String(fs.totalShares) },
    { label: "Open Positions", value: String(fs.openPositions), tone: fs.openPositions > 0 ? "neon" : "default" },
    { label: "Closed Positions", value: String(fs.closedPositions) },
    { label: "Win Rate", value: decided > 0 ? `${winRate}%` : "—" },
    {
      label: "Unrealized PnL",
      value: money(fs.unrealizedPnl),
      tone: fs.unrealizedPnl > 0 ? "neon" : fs.unrealizedPnl < 0 ? "crimson" : "default",
    },
    {
      label: "Realized PnL",
      value: money(fs.realizedPnl),
      tone: fs.realizedPnl > 0 ? "neon" : fs.realizedPnl < 0 ? "crimson" : "default",
    },
  ]

  return (
    <section
      aria-label="Engine Intelligence Feed"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-sm tracking-widest text-muted-foreground">ENGINE INTELLIGENCE FEED</h2>
        <div className="flex items-center gap-2 font-mono text-[10px] tracking-widest text-muted-foreground">
          <span
            className={`inline-block size-2 rounded-full ${snap.running ? "bg-neon glow-neon" : "bg-muted-foreground"}`}
            aria-hidden
          />
          {snap.running ? "LIVE" : "OFFLINE"}
        </div>
      </div>

      <div
        role="status"
        className={`rounded-md border px-3 py-2 font-mono text-xs ${
          status.tone === "green"
            ? "border-neon bg-neon/10 text-neon text-glow-neon glow-neon"
            : status.tone === "orange"
              ? "border-caution bg-caution/10 text-caution"
              : "border-border bg-secondary text-muted-foreground"
        }`}
      >
        {status.label}
      </div>

      {/* Chronological event stream — newest first, live-updating every second. */}
      <ul
        className="flex max-h-72 flex-col gap-1 overflow-y-auto font-mono text-[11px] leading-relaxed"
        aria-label="Engine event log"
        aria-live="polite"
      >
        {snap.events.length === 0 ? <li className="text-muted-foreground">&gt; no events yet</li> : null}
        {snap.events.map((ev, i) => (
          <li
            key={`${ev.tsMs}-${i}`}
            className={`flex gap-2 ${
              ev.level === "error"
                ? "text-crimson"
                : ev.level === "warn"
                  ? "text-caution"
                  : ev.level === "trade"
                    ? "text-neon"
                    : "text-muted-foreground"
            }`}
          >
            <span className="shrink-0 opacity-60">{new Date(ev.tsMs).toLocaleTimeString()}</span>
            <span className="min-w-0 break-words">{ev.msg}</span>
          </li>
        ))}
      </ul>

      {/* Running summary footer. */}
      <div className="mt-1 border-t border-border pt-3">
        <h3 className="mb-2 font-mono text-[10px] tracking-widest text-muted-foreground">SESSION SUMMARY</h3>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {summary.map((s) => (
            <div key={s.label} className="rounded-md border border-border bg-secondary/40 px-2.5 py-2">
              <dt className="font-mono text-[9px] leading-tight tracking-widest text-muted-foreground">
                {s.label.toUpperCase()}
              </dt>
              <dd
                className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${
                  s.tone === "neon"
                    ? "text-neon"
                    : s.tone === "crimson"
                      ? "text-crimson"
                      : "text-foreground"
                }`}
              >
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
