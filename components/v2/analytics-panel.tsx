"use client"

import { useAnalytics } from "@/components/v2/use-bot"
import type { AnalyticsSummary } from "@/lib/v2/engine/analytics"

/**
 * ANALYTICS — deep performance metrics computed server-side from the
 * permanent trades ledger. Read-only; polls at 10s only while visible.
 */
export function AnalyticsPanel({ active }: { active: boolean }) {
  const { data, error } = useAnalytics(active)

  if (error) {
    return (
      <div className="rounded-lg border border-crimson/50 bg-card p-4 font-mono text-xs text-crimson" role="alert">
        analytics unavailable: {error instanceof Error ? error.message : String(error)}
      </div>
    )
  }
  if (!data) {
    return <div className="rounded-lg border border-border bg-card p-4 font-mono text-xs text-muted-foreground">computing analytics…</div>
  }
  if (data.totalTrades === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center font-mono text-xs text-muted-foreground">
        NO SETTLED TRADES YET — analytics populate automatically as trades settle
      </div>
    )
  }

  const money = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`
  const tone = (v: number) => (v > 0 ? "text-neon" : v < 0 ? "text-crimson" : "text-muted-foreground")

  return (
    <div className="flex flex-col gap-4">
      {/* Headline strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="TOTAL RETURN" value={money(data.totalReturnUsd)} valueClass={tone(data.totalReturnUsd)} />
        <Stat label="ROI" value={data.roiPct !== null ? `${data.roiPct.toFixed(1)}%` : "—"} valueClass={tone(data.roiPct ?? 0)} />
        <Stat label="WIN RATE" value={`${data.winRate.toFixed(1)}%`} sub={`${data.wins}W / ${data.losses}L / ${data.scratches}S`} />
        <Stat
          label="PROFIT FACTOR"
          value={data.profitFactor === null ? "∞" : data.profitFactor.toFixed(2)}
          valueClass={data.profitFactor === null || data.profitFactor >= 1 ? "text-neon" : "text-crimson"}
        />
      </div>

      {/* Bankroll growth chart */}
      <section className="rounded-lg border border-border bg-card p-4" aria-label="Bankroll growth">
        <h3 className="mb-3 font-mono text-[10px] tracking-widest text-muted-foreground">BANKROLL GROWTH ({data.totalTrades} TRADES)</h3>
        <BankrollSparkline series={data.bankrollSeries} />
      </section>

      {/* Trade quality */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-4" aria-label="Trade quality">
          <h3 className="mb-3 font-mono text-[10px] tracking-widest text-muted-foreground">TRADE QUALITY</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-xs">
            <Row k="Avg trade" v={money(data.avgTradeUsd)} vClass={tone(data.avgTradeUsd)} />
            <Row k="Avg win" v={money(data.avgWinUsd)} vClass="text-neon" />
            <Row k="Avg loss" v={money(data.avgLossUsd)} vClass="text-crimson" />
            <Row k="Largest win" v={money(data.largestWinUsd)} vClass="text-neon" />
            <Row k="Largest loss" v={money(data.largestLossUsd)} vClass="text-crimson" />
            <Row k="Avg entry price" v={data.avgEntryPrice !== null ? `$${data.avgEntryPrice.toFixed(2)}` : "—"} />
            <Row k="Avg entry timing" v={data.avgEntrySecIntoSlot !== null ? `T+${Math.round(data.avgEntrySecIntoSlot)}s` : "—"} />
            <Row k="Avg hold time" v={data.avgHoldingTimeSec !== null ? `${Math.round(data.avgHoldingTimeSec)}s` : "—"} />
            <Row k="Fill rate" v={data.fillRate !== null ? `${data.fillRate.toFixed(1)}%` : "—"} />
            <Row k="Rejected orders" v={String(data.rejectedOrders)} vClass={data.rejectedOrders > 0 ? "text-caution" : undefined} />
          </dl>
        </section>

        <section className="rounded-lg border border-border bg-card p-4" aria-label="Risk and streaks">
          <h3 className="mb-3 font-mono text-[10px] tracking-widest text-muted-foreground">RISK + STREAKS</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-xs">
            <Row k="Max drawdown" v={money(-data.maxDrawdownUsd)} vClass={data.maxDrawdownUsd > 0 ? "text-crimson" : undefined} />
            <Row k="Max drawdown %" v={data.maxDrawdownPct !== null ? `${data.maxDrawdownPct.toFixed(1)}%` : "—"} />
            <Row
              k="Current streak"
              v={data.currentStreak.kind === "NONE" ? "—" : `${data.currentStreak.length} ${data.currentStreak.kind}${data.currentStreak.length > 1 ? "S" : ""}`}
              vClass={data.currentStreak.kind === "WIN" ? "text-neon" : data.currentStreak.kind === "LOSS" ? "text-crimson" : undefined}
            />
            <Row k="Longest win streak" v={String(data.longestWinStreak)} vClass="text-neon" />
            <Row k="Longest loss streak" v={String(data.longestLossStreak)} vClass="text-crimson" />
            <Row k="Trading days" v={String(data.tradingDays)} />
            <Row k="Avg profit day" v={money(data.avgDailyProfitUsd)} vClass="text-neon" />
            <Row k="Avg loss day" v={money(data.avgDailyLossUsd)} vClass="text-crimson" />
          </dl>
        </section>
      </div>

      {/* Daily PnL bars */}
      <section className="rounded-lg border border-border bg-card p-4" aria-label="Daily profit and loss">
        <h3 className="mb-3 font-mono text-[10px] tracking-widest text-muted-foreground">DAILY PNL (LAST {Math.min(data.dailyPnl.length, 30)} DAYS)</h3>
        <DailyPnlBars days={data.dailyPnl.slice(-30)} />
      </section>
    </div>
  )
}

function Stat({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="font-mono text-[9px] tracking-widest text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-lg tabular-nums ${valueClass ?? "text-foreground"}`}>{value}</div>
      {sub ? <div className="font-mono text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  )
}

function Row({ k, v, vClass }: { k: string; v: string; vClass?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={`text-right tabular-nums ${vClass ?? "text-foreground"}`}>{v}</dd>
    </>
  )
}

/** Dependency-free inline SVG sparkline of bankroll growth. */
function BankrollSparkline({ series }: { series: Array<{ t: number; balance: number }> }) {
  if (series.length < 2) {
    return <p className="font-mono text-xs text-muted-foreground">Need at least 2 settled trades to chart growth.</p>
  }
  const W = 720
  const H = 120
  const PAD = 4
  const min = Math.min(...series.map((p) => p.balance))
  const max = Math.max(...series.map((p) => p.balance))
  const span = max - min || 1
  const pts = series.map((p, i) => {
    const x = PAD + (i / (series.length - 1)) * (W - PAD * 2)
    const y = H - PAD - ((p.balance - min) / span) * (H - PAD * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const up = series[series.length - 1].balance >= series[0].balance
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" preserveAspectRatio="none" role="img" aria-label="Bankroll balance over time">
        <polyline points={pts.join(" ")} fill="none" stroke={up ? "var(--color-neon)" : "var(--color-crimson)"} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
        <span>${series[0].balance.toFixed(2)}</span>
        <span className={up ? "text-neon" : "text-crimson"}>${series[series.length - 1].balance.toFixed(2)}</span>
      </div>
    </div>
  )
}

/** Dependency-free daily PnL bar strip. */
function DailyPnlBars({ days }: { days: AnalyticsSummary["dailyPnl"] }) {
  if (days.length === 0) return <p className="font-mono text-xs text-muted-foreground">No settled days yet.</p>
  const maxAbs = Math.max(...days.map((d) => Math.abs(d.pnl)), 0.01)
  return (
    <div className="flex items-end gap-1" role="img" aria-label="Daily profit and loss bars">
      {days.map((d) => {
        const hPct = Math.max((Math.abs(d.pnl) / maxAbs) * 100, 4)
        return (
          <div key={d.date} className="group relative flex-1">
            <div
              className={`mx-auto w-full rounded-sm ${d.pnl >= 0 ? "bg-neon/70" : "bg-crimson/70"}`}
              style={{ height: `${(hPct * 64) / 100}px` }}
            />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded border border-border bg-popover px-2 py-1 font-mono text-[10px] text-popover-foreground group-hover:block">
              {d.date}: {d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(2)} ({d.trades})
            </div>
          </div>
        )
      })}
    </div>
  )
}
