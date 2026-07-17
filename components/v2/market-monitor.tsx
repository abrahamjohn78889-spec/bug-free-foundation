"use client"

import { memo, useEffect, useRef } from "react"
import { Radio, AlertTriangle, Wifi, WifiOff, Activity } from "lucide-react"
import type { EngineSnapshot } from "@/lib/v2/engine/types"

interface Props {
  snap: EngineSnapshot
}

function fmtCountdown(ms: number) {
  const clamped = Math.max(ms, 0)
  const m = Math.floor(clamped / 60000)
  const s = Math.floor((clamped % 60000) / 1000)
  const millis = Math.floor(clamped % 1000)
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(millis).padStart(3, "0")}`
}

/**
 * RENDER ISOLATION — the millisecond countdown animates at display refresh
 * rate via RAF. It previously lived as state in MarketMonitor, re-rendering
 * the entire 400+ line panel ~60x/second. Now the RAF writes DOM text
 * directly through refs, so the countdown costs ZERO React renders — the
 * parent only re-renders at the 1s snapshot cadence. Respects
 * prefers-reduced-motion by dropping to 1s text updates without ms digits.
 */
const CountdownCard = memo(function CountdownCard({
  tMinusMs,
  slotEndMs,
}: {
  tMinusMs: number
  slotEndMs: number
}) {
  const targetRef = useRef(Date.now() + tMinusMs)
  const timeRef = useRef<HTMLTimeElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    targetRef.current = Date.now() + tMinusMs
  }, [tMinusMs, slotEndMs])

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let raf = 0
    let interval: ReturnType<typeof setInterval> | undefined
    let lastBorder = ""

    const paint = () => {
      let rem = targetRef.current - Date.now()
      if (rem <= 0) rem += 5 * 60 * 1000
      if (timeRef.current) {
        timeRef.current.textContent = reduceMotion
          ? fmtCountdown(rem).slice(0, 5) // mm:ss only — no ms flicker
          : fmtCountdown(rem)
      }
      // Border tone changes are rare — write only on transitions.
      const border =
        rem <= 2000 ? "electric-border-crimson" : rem <= 20000 && rem > 2000 ? "electric-border" : "border-border"
      if (border !== lastBorder && boxRef.current) {
        boxRef.current.classList.remove("electric-border-crimson", "electric-border", "border-border")
        boxRef.current.classList.add(border)
        lastBorder = border
      }
    }

    if (reduceMotion) {
      paint()
      interval = setInterval(paint, 1000)
    } else {
      const step = () => {
        paint()
        raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    }
    return () => {
      cancelAnimationFrame(raf)
      if (interval) clearInterval(interval)
    }
  }, [])

  const slotEndLabel = new Date(slotEndMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })

  return (
    <div ref={boxRef} className="flex flex-col items-center rounded-md border border-border bg-secondary/40 py-4">
      <span className="font-mono text-[10px] tracking-widest text-muted-foreground">CANDLE EXPIRY</span>
      <time ref={timeRef} className="font-mono text-4xl tabular-nums text-foreground md:text-5xl" aria-live="off">
        {fmtCountdown(tMinusMs)}
      </time>
      <span className="mt-1 font-mono text-[10px] text-muted-foreground">MARKET ENDS {slotEndLabel} LOCAL</span>
    </div>
  )
})

function fmtAge(ms: number | null): string {
  if (ms === null) return "never"
  if (ms < 1000) return `${ms}ms ago`
  return `${(ms / 1000).toFixed(1)}s ago`
}

function fmtCents(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}¢`
}

function fmtUsd(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

/** One labelled stat cell used across the quote/telemetry grids. */
function Stat({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] tracking-widest text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${className ?? "text-foreground"}`}>{value}</span>
    </div>
  )
}

export function MarketMonitor({ snap }: Props) {
  // NOTE: no local ticker needed — the snap prop already arrives fresh every
  // second from the status poll, which keeps all "Xs ago" ages current. The
  // ms countdown animates independently inside CountdownCard (zero renders).

  // Contract prices come ONLY from the live Polymarket CLOB. When the feed is
  // not fresh they are null and every consumer shows NO DATA — never a model.
  const pricesAreLive = snap.clobPricesFresh
  const hasPrices = pricesAreLive && snap.upTokenPrice !== null && snap.downTokenPrice !== null
  const quote = hasPrices ? snap.clobQuote : null

  const lockedDir = snap.standingLimitOrder?.lockedDirection ?? null
  const majoritySide: "UP" | "DOWN" | null = hasPrices
    ? (lockedDir ?? (snap.upTokenPrice! >= snap.downTokenPrice! ? "UP" : "DOWN"))
    : null
  const majorityPrice = majoritySide === null ? null : majoritySide === "UP" ? snap.upTokenPrice! : snap.downTokenPrice!
  const majorityProbability = majorityPrice === null ? null : Math.round(majorityPrice * 100)

  // Resting order shown in the Signal Tank (SLO leads; strategy order fallback).
  const sl = snap.standingLimitOrder
  const restingOrder =
    sl && sl.status === "RESTING" && sl.restingSide !== null
      ? { side: sl.restingSide, shares: sl.shares, price: sl.limitPrice, source: "SLO" as const }
      : snap.openOrder
        ? { side: snap.openOrder.side, shares: snap.openOrder.shares, price: snap.openOrder.price, source: "STRAT" as const }
        : null

  const marketStatus = snap.awaitingResolution
    ? { label: "SETTLING", className: "text-caution" }
    : snap.liveMarket
      ? snap.liveMarket.closed
        ? { label: "CLOSED", className: "text-crimson" }
        : { label: "OPEN", className: "text-neon text-glow-neon" }
      : snap.running
        ? { label: "AWAITING MARKET", className: "text-caution" }
        : { label: "OFFLINE", className: "text-muted-foreground" }

  // --- connection health (always computed; shown in the telemetry strip) ---
  const diag = snap.clobDiagnostics
  const now = Date.now()
  const wsMsgAgeMs = diag.ws.lastMessageAtMs > 0 ? now - diag.ws.lastMessageAtMs : null
  const wsHealthy = diag.ws.connected && wsMsgAgeMs !== null && wsMsgAgeMs < 30_000
  const apiOkAgeMs = diag.lastSuccessMs > 0 ? now - diag.lastSuccessMs : null
  const apiHealthy = apiOkAgeMs !== null && apiOkAgeMs < 15_000 && diag.consecutiveFailures === 0
  const lastFailAgeMs = diag.lastFailMs > 0 ? now - diag.lastFailMs : null

  // Spread per side (ask − bid), from the live quote only.
  const upSpread = quote && quote.up.bid !== null ? quote.up.ask - quote.up.bid : null
  const downSpread = quote && quote.down.bid !== null ? quote.down.ask - quote.down.bid : null

  // Total two-sided book liquidity (USD notional across all levels, both tokens).
  const book = snap.clobBook
  const totalLiquidityUsd =
    book.up || book.down
      ? (book.up ? book.up.bidNotionalUsd + book.up.askNotionalUsd : 0) +
        (book.down ? book.down.bidNotionalUsd + book.down.askNotionalUsd : 0)
      : null

  const delta = snap.clobPriceChange

  return (
    <section aria-label="Live Market Monitor" className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-mono text-sm tracking-widest text-muted-foreground">[ B ] SIGNAL TANK</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span
            title={wsHealthy ? "CLOB WebSocket stream connected" : "CLOB WebSocket down — REST polling is the active fallback"}
            className={`flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] ${
              wsHealthy ? "bg-neon/10 text-neon" : "bg-caution/10 text-caution"
            }`}
          >
            {wsHealthy ? <Wifi className="size-3" aria-hidden /> : <WifiOff className="size-3" aria-hidden />}
            WS {wsHealthy ? (diag.ws.pingRttMs !== null ? `${diag.ws.pingRttMs}ms` : "LIVE") : "DOWN"}
          </span>
          <span
            title={apiHealthy ? "CLOB REST polling healthy" : "CLOB REST polling degraded"}
            className={`flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] ${
              apiHealthy ? "bg-neon/10 text-neon" : "bg-caution/10 text-caution"
            }`}
          >
            <Activity className="size-3" aria-hidden />
            API {apiHealthy ? (diag.apiLatencyMs !== null ? `${diag.apiLatencyMs}ms` : "OK") : "DEGRADED"}
          </span>
          <span
            title={
              hasPrices
                ? "Prices sourced live from the Polymarket CLOB"
                : "No live Polymarket data — waiting for the CLOB feed (no model/estimate is ever shown)"
            }
            className={`flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] ${
              hasPrices ? "bg-neon/10 text-neon" : "bg-caution/10 text-caution"
            }`}
          >
            {hasPrices ? <Radio className="size-3" aria-hidden /> : <AlertTriangle className="size-3" aria-hidden />}
            {hasPrices ? "LIVE" : "NO DATA"}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {snap.clockSynced ? `NTP ${snap.clockOffsetMs >= 0 ? "+" : ""}${snap.clockOffsetMs}ms` : "LOCAL CLOCK"}
          </span>
        </div>
      </header>

      {/* countdown — render-isolated, animates via direct DOM writes */}
      <CountdownCard tMinusMs={snap.tMinusMs} slotEndMs={snap.slotEndMs} />

      {/* Gamma-resolved market context */}
      <div className="rounded-md border border-border bg-secondary/40 p-3 font-mono text-xs">
        <div className="flex items-center justify-between">
          <span className="tracking-widest text-muted-foreground">MARKET CONTEXT</span>
          {snap.awaitingResolution ? (
            <span className="text-caution">SETTLING…</span>
          ) : snap.liveMarket ? (
            <span className="flex items-center gap-1 text-neon text-glow-neon">
              <Radio className="size-3" aria-hidden />
              SYNCED
            </span>
          ) : (
            <span className="text-caution">{snap.running ? "AWAITING GAMMA" : "OFFLINE"}</span>
          )}
        </div>
        {snap.liveMarket ? (
          <div className="mt-2 flex flex-col gap-1">
            <div className="text-pretty text-foreground">{snap.liveMarket.question || snap.liveMarket.slug}</div>
            <div className="text-muted-foreground">
              slug: <span className="text-foreground">{snap.liveMarket.slug}</span>
            </div>
            <div className="truncate text-muted-foreground">
              cond: <span className="text-foreground">{snap.liveMarket.conditionId}</span>
            </div>
            <div className="truncate text-muted-foreground">
              up token: <span className="text-foreground">…{snap.liveMarket.upTokenId.slice(-20)}</span>
            </div>
            <div className="truncate text-muted-foreground">
              down token: <span className="text-foreground">…{snap.liveMarket.downTokenId.slice(-20)}</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
              <span>
                gamma vol: <span className="text-foreground">{fmtUsd(snap.liveMarket.volumeUsd)}</span>
              </span>
              <span>
                gamma liq: <span className="text-foreground">{fmtUsd(snap.liveMarket.liquidityUsd)}</span>
              </span>
              <span>
                discovery: <span className={snap.marketDiscovery === "ready" ? "text-neon" : "text-caution"}>{snap.marketDiscovery ?? "n/a"}</span>
              </span>
            </div>
          </div>
        ) : (
          <div className="mt-2 text-muted-foreground">No Polymarket listing resolved for this candle yet</div>
        )}
      </div>

      {/* Live order-book quote per side — bid/ask/mid/last/spread, all from
          the Polymarket CLOB. Rows render NO DATA when the feed is stale. */}
      <div className="grid grid-cols-1 gap-2 font-mono text-xs sm:grid-cols-2">
        {(["UP", "DOWN"] as const).map((side) => {
          const q = side === "UP" ? quote?.up : quote?.down
          const b = side === "UP" ? book.up : book.down
          const spread = side === "UP" ? upSpread : downSpread
          const tone = side === "UP" ? "text-neon" : "text-crimson"
          return (
            <div key={side} className="rounded-md border border-border bg-secondary/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className={`text-sm font-semibold ${tone}`}>{side}</span>
                <span className="text-lg font-semibold tabular-nums text-foreground">
                  {q ? `${(q.ask * 100).toFixed(1)}¢` : "NO DATA"}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-x-2 gap-y-2">
                <Stat label="BEST BID" value={fmtCents(q?.bid)} />
                <Stat label="BEST ASK" value={fmtCents(q?.ask)} />
                <Stat label="MID" value={fmtCents(q?.mid)} />
                <Stat label="SPREAD" value={spread !== null && spread !== undefined ? `${(spread * 100).toFixed(1)}¢` : "—"} />
                <Stat
                  label="LAST TRADE"
                  value={
                    q?.last !== null && q?.last !== undefined ? (
                      <>
                        {fmtCents(q.last)}
                        {q.lastSide ? (
                          <span className={`ml-1 text-[9px] ${q.lastSide === "BUY" ? "text-neon" : "text-crimson"}`}>{q.lastSide}</span>
                        ) : null}
                      </>
                    ) : (
                      "—"
                    )
                  }
                />
                <Stat
                  label="60s Δ"
                  value={
                    delta ? (
                      <span className={(side === "UP" ? delta.up : delta.down) >= 0 ? "text-neon" : "text-crimson"}>
                        {(side === "UP" ? delta.up : delta.down) >= 0 ? "+" : ""}
                        {((side === "UP" ? delta.up : delta.down) * 100).toFixed(1)}¢
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
                <Stat label="BID DEPTH" value={b ? `${b.bidLevels} lvl / ${fmtUsd(b.bidNotionalUsd)}` : "—"} />
                <Stat label="ASK DEPTH" value={b ? `${b.askLevels} lvl / ${fmtUsd(b.askNotionalUsd)}` : "—"} />
                <Stat label="BOOK AGE" value={b ? fmtAge(now - b.fetchedAtMs) : "—"} />
              </div>
            </div>
          )
        })}
      </div>

      {/* live BTC / leading side / probability / market status */}
      <div className="grid grid-cols-2 gap-2 font-mono text-xs md:grid-cols-4">
        <div className="rounded-md border border-border bg-secondary/40 p-3">
          <div className="text-muted-foreground">LIVE BTC ({snap.spot?.source ?? "—"})</div>
          <div className="mt-1 text-lg tabular-nums text-foreground">
            {snap.spot ? `$${snap.spot.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
          </div>
        </div>
        <div className="rounded-md border border-border bg-secondary/40 p-3">
          <div className="text-muted-foreground">{lockedDir ? "LOCKED SIDE" : "LEADING SIDE"}</div>
          <div
            className={`mt-1 text-lg font-semibold tabular-nums ${
              majoritySide === null ? "text-caution" : majoritySide === "UP" ? "text-neon" : "text-crimson"
            }`}
          >
            {majoritySide === null ? (
              "NO DATA"
            ) : (
              <>
                {majoritySide} <span className="text-sm text-muted-foreground">${majorityPrice!.toFixed(2)}</span>
              </>
            )}
          </div>
        </div>
        <div className="rounded-md border border-border bg-secondary/40 p-3">
          <div className="text-muted-foreground">LIVE PROBABILITY</div>
          <div
            className={`mt-1 text-lg font-semibold tabular-nums ${
              majoritySide === null ? "text-caution" : majoritySide === "UP" ? "text-neon" : "text-crimson"
            }`}
          >
            {majorityProbability === null ? (
              "NO DATA"
            ) : (
              <>
                {majorityProbability}% <span className="text-sm text-muted-foreground">{majoritySide}</span>
              </>
            )}
          </div>
        </div>
        <div className="rounded-md border border-border bg-secondary/40 p-3">
          <div className="text-muted-foreground">MARKET STATUS</div>
          <div className={`mt-1 text-lg font-semibold ${marketStatus.className}`}>{marketStatus.label}</div>
        </div>
      </div>

      {/* Feed + engine telemetry — always visible so the operator can see
          connection health, latency, freshness, and engine state at a glance. */}
      <div className="rounded-md border border-border bg-secondary/40 p-3 font-mono text-xs">
        <div className="mb-2 tracking-widest text-muted-foreground">FEED TELEMETRY</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 md:grid-cols-4">
          <Stat
            label="WS STATUS"
            value={wsHealthy ? "CONNECTED" : diag.ws.connected ? "IDLE" : "RECONNECTING"}
            className={wsHealthy ? "text-neon" : "text-caution"}
          />
          <Stat label="WS LATENCY" value={diag.ws.pingRttMs !== null ? `${diag.ws.pingRttMs}ms` : "—"} />
          <Stat label="WS LAST MSG" value={fmtAge(wsMsgAgeMs)} />
          <Stat
            label="WS RECONNECTS"
            value={`${diag.ws.reconnectAttempts} att / ${diag.ws.totalDisconnects} drops`}
            className={diag.ws.totalDisconnects > 0 ? "text-caution" : "text-foreground"}
          />
          <Stat
            label="API STATUS"
            value={apiHealthy ? "HEALTHY" : diag.consecutiveFailures > 0 ? `${diag.consecutiveFailures} FAILS` : "STALE"}
            className={apiHealthy ? "text-neon" : "text-caution"}
          />
          <Stat label="API LATENCY" value={diag.apiLatencyMs !== null ? `${diag.apiLatencyMs}ms` : "—"} />
          <Stat label="POLL FREQ" value={`${(diag.pollIntervalMs / 1000).toFixed(0)}s + WS push`} />
          <Stat
            label="POLL RECORD"
            value={`${diag.totalPolls - diag.totalFailedPolls}/${diag.totalPolls} ok`}
            className={diag.totalFailedPolls > 0 ? "text-caution" : "text-foreground"}
          />
          <Stat label="LAST OK" value={fmtAge(apiOkAgeMs)} className={apiHealthy ? "text-foreground" : "text-caution"} />
          <Stat label="LAST FAIL" value={lastFailAgeMs !== null ? fmtAge(lastFailAgeMs) : "never"} />
          <Stat label="QUOTE AGE" value={`UP ${fmtAge(diag.upQuoteAgeMs)} / DN ${fmtAge(diag.downQuoteAgeMs)}`} />
          <Stat label="BOOK LIQUIDITY" value={totalLiquidityUsd !== null ? fmtUsd(totalLiquidityUsd) : "—"} />
          <Stat label="ENGINE STATE" value={snap.phase} className={snap.running ? "text-neon" : "text-muted-foreground"} />
          <Stat label="STRATEGY" value={snap.activeStrategy ? snap.activeStrategy.toUpperCase() : "SLO ONLY"} />
          <Stat
            label="TRIGGER"
            value={sl ? sl.status : "NOT ARMED"}
            className={sl && (sl.status === "ARMED" || sl.status === "RESTING" || sl.status === "TRIGGERED") ? "text-neon" : "text-muted-foreground"}
          />
          <Stat
            label="MARKET REFRESH"
            value={snap.marketDiscovery === "ready" ? "SYNCED" : snap.marketDiscovery === "waiting" ? "RESOLVING" : "n/a"}
            className={snap.marketDiscovery === "ready" ? "text-neon" : "text-caution"}
          />
        </div>
      </div>

      {/* CLOB failure diagnostic — full detail, only when prices are unavailable. */}
      {!hasPrices && (
        <div className="rounded-md border border-caution/40 bg-caution/5 p-3 font-mono text-[11px]">
          <div className="mb-2 flex items-center gap-2 text-caution">
            <AlertTriangle className="size-3 shrink-0" aria-hidden />
            <span className="tracking-wider">CLOB FEED DIAGNOSTIC</span>
          </div>
          <dl className="flex flex-col gap-1 text-muted-foreground">
            <div className="flex gap-2">
              <dt className="shrink-0 text-[10px] tracking-widest">UP TOKEN</dt>
              <dd className="break-all text-foreground">
                {diag.upTokenId ? `…${diag.upTokenId.slice(-16)}` : "not resolved (market discovery pending)"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-[10px] tracking-widest">DOWN TOKEN</dt>
              <dd className="break-all text-foreground">{diag.downTokenId ? `…${diag.downTokenId.slice(-16)}` : "not resolved"}</dd>
            </div>
            {diag.lastFailReason && (
              <div className="flex gap-2">
                <dt className="shrink-0 text-[10px] tracking-widest">REASON</dt>
                <dd className="break-all text-caution">{diag.lastFailReason}</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {/* open order line */}
      <div className="rounded-md border border-border bg-secondary/40 p-3 font-mono text-xs">
        <span className="text-muted-foreground">RESTING ORDER: </span>
        {restingOrder ? (
          <span className="text-neon text-glow-neon">
            {restingOrder.side} {restingOrder.shares} @ ${restingOrder.price.toFixed(2)}
            <span className="ml-2 text-[10px] tracking-widest text-muted-foreground">
              {restingOrder.source === "SLO" ? "STANDING LIMIT" : "STRATEGY"}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">none</span>
        )}
        {snap.lastCancelReplaceMs !== null ? (
          <span className="ml-3 text-muted-foreground">
            last C/R:{" "}
            <span className={snap.lastCancelReplaceMs <= snap.config.cancelReplaceBudgetMs ? "text-neon" : "text-caution"}>
              {snap.lastCancelReplaceMs}ms
            </span>
          </span>
        ) : null}
      </div>
    </section>
  )
}
