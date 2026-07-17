"use client"

import { useEffect, useState } from "react"
import { Crosshair, X, TrendingUp, TrendingDown, Radio, AlertTriangle, Pause, Play, Zap, Lock } from "lucide-react"
import type { EngineSnapshot, SloSizingMode, StandingOrderStatus } from "@/lib/v2/engine/types"
import { sendControl } from "./use-bot"
import { NumberField } from "./number-field"

interface Props {
  snap: EngineSnapshot
  onChanged: () => void
}

/** Human-facing display for each lifecycle state. */
const STATUS_DISPLAY: Record<StandingOrderStatus, { label: string; className: string; pulse?: boolean }> = {
  ARMED: { label: "ARMED", className: "text-primary bg-primary/10", pulse: true },
  TRIGGERED: { label: "TRIGGERED", className: "text-neon bg-neon/10", pulse: true },
  RESTING: { label: "RESTING", className: "text-neon bg-neon/10", pulse: true },
  FILLED: { label: "FILLED", className: "text-neon bg-neon/10" },
  WAITING_MARKET: { label: "WAITING MARKET", className: "text-caution bg-caution/10" },
  NO_DATA: { label: "NO DATA — HOLDING", className: "text-caution bg-caution/10", pulse: true },
  OUT_OF_RANGE: { label: "OUT OF RANGE", className: "text-caution bg-caution/10" },
  INSUFFICIENT: { label: "INSUFFICIENT", className: "text-destructive bg-destructive/10" },
  REFRESHING: { label: "REFRESHING", className: "text-caution bg-caution/10", pulse: true },
  PAUSED: { label: "PAUSED", className: "text-muted-foreground bg-muted/20" },
  BLOCKED: { label: "BLOCKED — RISK GATE", className: "text-destructive bg-destructive/10", pulse: true },
  WINDOW_WAITING: { label: "AWAITING ENTRY WINDOW", className: "text-caution bg-caution/10", pulse: true },
  WINDOW_EXPIRED: { label: "SETTLED — RE-ARMING", className: "text-caution bg-caution/10" },
  WAITING_SETTLE: { label: "WAITING SETTLE", className: "text-caution bg-caution/10", pulse: true },
}

/** Final entry window choices (seconds before settlement); 0 = disabled. Mirrors SLO_WINDOW_OPTIONS_SEC. */
const WINDOW_CHOICES = [0, 5, 15, 30, 45, 60, 90, 120] as const

/** Percent-of-pool presets for compounding mode. */
const PERCENT_PRESETS = [5, 10, 25, 50, 100] as const

export function LimitOrderPanel({ snap, onChanged }: Props) {
  const [target, setTarget] = useState(0.95)
  const [trigger, setTrigger] = useState(0.94)
  const [shares, setShares] = useState(snap.config.minShares ?? 5)
  // Default guardrails: wide band (0.01–0.99) so a fresh arm never
  // goes OUT_OF_RANGE immediately due to a too-narrow default.
  const [minPrice, setMinPrice] = useState(0.01)
  const [maxPrice, setMaxPrice] = useState(0.99)
  // Position sizing model: FIXED_SHARES (legacy), FIXED_USD, PERCENT (compounding).
  const [sizingMode, setSizingMode] = useState<SloSizingMode>("FIXED_SHARES")
  const [usdAmount, setUsdAmount] = useState(10)
  const [percent, setPercent] = useState(10)
  // Entry time window in seconds (0 = disabled).
  const [windowSec, setWindowSec] = useState(0)
  const [busy, setBusy] = useState(false)
  // Track whether we've already synced from a live armed order so we
  // don't overwrite the user's in-progress edits on every poll tick.
  const [synced, setSynced] = useState(false)

  const sl = snap.standingLimitOrder

  // Sync form fields from an armed order's params once, the first time
  // sl becomes non-null (e.g. after a page reload with an active order).
  useEffect(() => {
    if (sl && !synced) {
      setTarget(sl.limitPrice)
      setTrigger(sl.triggerPrice)
      setShares(sl.sizingMode === "FIXED_SHARES" ? sl.sizeValue : sl.shares)
      setMinPrice(sl.minPrice)
      setMaxPrice(sl.maxPrice)
      setSizingMode(sl.sizingMode)
      if (sl.sizingMode === "FIXED_USD") setUsdAmount(sl.sizeValue)
      if (sl.sizingMode === "PERCENT") setPercent(sl.sizeValue)
      setWindowSec(sl.entryWindowMs !== null ? Math.round(sl.entryWindowMs / 1000) : 0)
      setSynced(true)
    }
    // When the order is cleared, reset the synced flag so the next arm syncs.
    if (!sl) setSynced(false)
  }, [sl, synced])
  const availableCapital = snap.balance + snap.dustReserve
  // Estimated shares / cost for the NEXT order, per sizing mode. The engine
  // recomputes authoritatively at fire time; this is a live preview.
  const estimatedShares =
    sizingMode === "FIXED_USD"
      ? Math.floor(usdAmount / target)
      : sizingMode === "PERCENT"
        ? Math.floor(((availableCapital * percent) / 100) / target)
        : shares
  const requiredCapital = target * estimatedShares
  const triggerValid = trigger > 0 && trigger <= target
  const sizingValid =
    sizingMode === "FIXED_SHARES"
      ? shares >= (snap.config.minShares ?? 5)
      : sizingMode === "FIXED_USD"
        ? usdAmount > 0 && estimatedShares >= (snap.config.minShares ?? 1)
        : percent >= 1 && percent <= 100 && estimatedShares >= 1
  const canArm = requiredCapital <= availableCapital && triggerValid && minPrice < maxPrice && sizingValid

  const pricesAreLive = snap.clobPricesFresh
  const upPrice = snap.upTokenPrice
  const downPrice = snap.downTokenPrice
  // Live only when the CLOB feed is fresh AND both contract prices exist.
  const hasPrices = pricesAreLive && upPrice !== null && downPrice !== null

  const statusDisplay = sl ? STATUS_DISPLAY[sl.status] : null

  // Dispatch a control action and refresh the snapshot
  const act = async (payload: Record<string, unknown>) => {
    setBusy(true)
    try {
      await sendControl(payload)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label="Standing Limit Order"
      className={`flex flex-col gap-4 rounded-lg border p-4 transition-colors ${
        sl ? "border-primary/50 bg-primary/5" : "border-border bg-card"
      }`}
    >
      {/* Header */}
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-sm tracking-widest text-muted-foreground">STANDING LIMIT ORDER</h2>
        <div className="flex items-center gap-3">
          <span
            title={
              hasPrices
                ? "Prices sourced live from the Polymarket CLOB"
                : "No live Polymarket data — engine holds and never trades on a model/estimate"
            }
            className={`flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] ${
              hasPrices ? "bg-neon/10 text-neon" : "bg-caution/10 text-caution"
            }`}
          >
            {hasPrices ? <Radio className="size-3" aria-hidden /> : <AlertTriangle className="size-3" aria-hidden />}
            {hasPrices ? "LIVE" : "NO DATA"}
          </span>
          {statusDisplay ? (
            <span
              className={`rounded px-2 py-0.5 font-mono text-xs font-semibold tracking-widest ${statusDisplay.className} ${
                statusDisplay.pulse ? "animate-pulse" : ""
              }`}
            >
              {statusDisplay.label}
            </span>
          ) : (
            <span className="rounded bg-muted/10 px-2 py-0.5 font-mono text-xs font-semibold tracking-widest text-muted-foreground">
              INACTIVE
            </span>
          )}
        </div>
      </header>

      {/* Active order monitor */}
      {sl ? (
        <div className="flex flex-col gap-3 rounded-md border border-primary/20 bg-background p-3 font-mono text-xs">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Runs independently of the engine &amp; time window</span>
            <span
              className={`rounded px-1.5 py-0.5 font-semibold ${sl.live ? "bg-neon/10 text-neon" : "bg-primary/10 text-primary"}`}
            >
              {sl.live ? "LIVE CLOB" : "PAPER"}
            </span>
          </div>

          {/* Majority side (live) */}
          <div className="rounded border border-border/50 bg-muted/30 p-2">
            <div className="mb-2 flex items-center justify-between text-muted-foreground">
              <span className="tracking-widest">MAJORITY SIDE (LIVE)</span>
              {!pricesAreLive && <AlertTriangle className="size-3 text-caution" aria-hidden />}
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-1 items-center gap-1">
                <TrendingUp className={`size-3 shrink-0 ${sl.majoritySide === "UP" ? "text-neon" : "text-muted-foreground"}`} aria-hidden />
                <span className="text-muted-foreground">Up</span>
                <span className={`ml-auto font-semibold tabular-nums ${sl.majoritySide === "UP" ? "text-neon" : "text-foreground"}`}>
                  {upPrice !== null ? `¢${Math.round(upPrice * 100)}` : "—"}
                </span>
              </div>
              <div className="flex flex-1 items-center gap-1">
                <TrendingDown className={`size-3 shrink-0 ${sl.majoritySide === "DOWN" ? "text-crimson" : "text-muted-foreground"}`} aria-hidden />
                <span className="text-muted-foreground">Down</span>
                <span className={`ml-auto font-semibold tabular-nums ${sl.majoritySide === "DOWN" ? "text-crimson" : "text-foreground"}`}>
                  {downPrice !== null ? `¢${Math.round(downPrice * 100)}` : "—"}
                </span>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-border/50 pt-2">
              <span className="text-muted-foreground">Leading side</span>
              <span className={`font-semibold ${sl.majoritySide === "UP" ? "text-neon" : sl.majoritySide === "DOWN" ? "text-crimson" : "text-foreground"}`}>
                {sl.majoritySide ?? "—"} {sl.majoritySide ? `¢${Math.round(sl.majorityPrice * 100)}` : ""}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-border/50 pt-2">
              <span className="text-muted-foreground">Locked direction</span>
              {sl.lockedDirection ? (
                <span
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-widest ${
                    sl.lockedDirection === "UP" ? "bg-neon/10 text-neon" : "bg-crimson/10 text-crimson"
                  }`}
                >
                  <Lock className="size-3" aria-hidden />
                  {sl.lockedDirection} (LOCKED)
                </span>
              ) : (
                <span className="text-[10px] tracking-widest text-muted-foreground">UNLOCKED — racing to trigger</span>
              )}
            </div>
          </div>

          {/* Trigger / target ladder */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded border border-border/50 bg-muted/30 p-2">
              <div className="text-muted-foreground">TRIGGER</div>
              <div className="text-base font-semibold tabular-nums text-caution">
                {sl.triggerPrice != null ? `$${sl.triggerPrice.toFixed(2)}` : "—"}
              </div>
            </div>
            <div className="rounded border border-border/50 bg-muted/30 p-2">
              <div className="text-muted-foreground">TARGET BUY</div>
              <div className="text-base font-semibold tabular-nums text-primary">
                {sl.limitPrice != null ? `$${sl.limitPrice.toFixed(2)}` : "—"}
              </div>
            </div>
          </div>

          {/* Order + band */}
          <div className="flex items-center justify-between">
            <span className="tracking-widest text-muted-foreground">LIMIT BUY</span>
            <span className="font-semibold text-primary">
              {sl.shares} @ {sl.limitPrice != null ? `$${sl.limitPrice.toFixed(2)}` : "—"}{sl.restingSide ? ` · ${sl.restingSide}` : ""}
            </span>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Sizing</span>
            <span className="text-foreground">
              {sl.sizingMode === "FIXED_SHARES"
                ? `Fixed ${sl.sizeValue} shares`
                : sl.sizingMode === "FIXED_USD"
                  ? `$${sl.sizeValue.toFixed(2)} per order (≈${sl.shares} sh)`
                  : `${sl.sizeValue}% of pool — compounding (≈${sl.shares} sh)`}
            </span>
          </div>
          {sl.entryWindowMs !== null &&
            (sl.entryWindowOpensInMs !== null && sl.entryWindowOpensInMs > 0 ? (
              // Waiting phase: monitoring only — show when the final window opens.
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Entry window opens in</span>
                <span className="font-semibold tabular-nums text-caution">
                  {Math.ceil(sl.entryWindowOpensInMs / 1000)}s (final {Math.round(sl.entryWindowMs / 1000)}s)
                </span>
              </div>
            ) : (
              // Active phase: window is open until settlement — show the settlement countdown.
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block size-1.5 animate-pulse rounded-full bg-neon" aria-hidden />
                  <span className="font-semibold tracking-widest text-neon">ENTRY WINDOW ACTIVE</span>
                </span>
                <span className="font-semibold tabular-nums text-neon">
                  Settlement in {Math.max(0, Math.ceil(snap.tMinusMs / 1000))}s
                </span>
              </div>
            ))}
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Guardrail band</span>
            <span className="text-foreground">
              {sl.minPrice != null ? `$${sl.minPrice.toFixed(2)}` : "—"} – {sl.maxPrice != null ? `$${sl.maxPrice.toFixed(2)}` : "—"}
            </span>
          </div>

          {/* Capital */}
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Estimated cost</span>
            <span className={sl.shares * sl.limitPrice > availableCapital ? "text-destructive" : "text-foreground"}>
              ${(sl.shares * sl.limitPrice).toFixed(2)}
            </span>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Available balance</span>
            <span className="text-foreground">${availableCapital.toFixed(2)}</span>
          </div>

          {/* Live open position — shown the instant a fill is confirmed */}
          {sl.openPosition && (
            <div className="rounded-md border border-neon/40 bg-neon/5 p-3 font-mono text-[10px] leading-relaxed">
              <div className="mb-2 flex items-center gap-1.5 font-semibold tracking-widest text-neon">
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-neon" aria-hidden />
                OPEN POSITION
              </div>
              <div className="grid grid-cols-3 gap-x-4 gap-y-1.5">
                <div>
                  <div className="text-muted-foreground">SIDE</div>
                  <div className={sl.openPosition.side === "UP" ? "text-neon font-semibold" : "text-crimson font-semibold"}>
                    {sl.openPosition.side}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">ENTRY PRICE</div>
                  <div className="tabular-nums text-foreground">${sl.openPosition.entryPrice.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">SHARES</div>
                  <div className="tabular-nums text-foreground">{sl.openPosition.shares}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">COST</div>
                  <div className="tabular-nums text-foreground">${sl.openPosition.cost.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">MARK PRICE</div>
                  <div className="tabular-nums text-foreground">
                    {sl.openPosition.markPrice !== null ? `$${sl.openPosition.markPrice.toFixed(2)}` : (
                      <span className="text-caution">NO DATA</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">UNREALIZED PNL</div>
                  {sl.openPosition.unrealizedPnl !== null ? (
                    <div className={`tabular-nums font-semibold ${sl.openPosition.unrealizedPnl >= 0 ? "text-neon" : "text-crimson"}`}>
                      {sl.openPosition.unrealizedPnl >= 0 ? "+" : ""}${sl.openPosition.unrealizedPnl.toFixed(2)}
                    </div>
                  ) : (
                    <div className="tabular-nums text-caution" title="Live Polymarket mark unavailable — PnL pending">
                      pending
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-2 truncate text-muted-foreground">
                market: {sl.openPosition.marketId} · filled {new Date(sl.openPosition.filledAtMs).toLocaleTimeString()}
              </div>
            </div>
          )}

          {/* Market resolution status */}
          {sl.marketClosed && (
            <div className="rounded-md border border-muted/60 bg-muted/10 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
              <div className="mb-0.5 flex items-center gap-1.5 font-semibold tracking-widest text-caution">
                <AlertTriangle className="size-3 shrink-0" aria-hidden />
                MARKET CLOSED
              </div>
              <div>
                {sl.awaitingEarlySettlement
                  ? "Awaiting official settlement from Polymarket…"
                  : "This 5-minute market has resolved. Open positions will be settled automatically."}
              </div>
            </div>
          )}

          {/* Execution stats */}
          <div className="flex items-center justify-between border-t border-primary/20 pt-2">
            <div>
              <div className="text-muted-foreground">Fills (this market)</div>
              <div className="text-base font-semibold text-primary">{sl.executionCount}</div>
            </div>
            <div className="text-center">
              <div className="text-muted-foreground">Open lots</div>
              <div className="text-base font-semibold text-neon">{sl.openPositionCount}</div>
            </div>
            <div className="text-right">
              <div className="text-muted-foreground">Last Fill</div>
              <div className="text-foreground">
                {sl.lastExecutedAtMs ? new Date(sl.lastExecutedAtMs).toLocaleTimeString() : "—"}
              </div>
            </div>
          </div>

          {/* BLOCKED (risk gate) diagnostic banner */}
          {sl.status === "BLOCKED" && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 font-mono text-[10px] leading-relaxed text-destructive">
              <div className="mb-1 flex items-center gap-1.5 font-semibold tracking-widest">
                <AlertTriangle className="size-3 shrink-0" aria-hidden />
                ORDERS BLOCKED BY RISK GATE
              </div>
              <div className="text-destructive/80">
                {sl.blockedReason ?? "The risk manager is vetoing order submissions."}
              </div>
              <div className="mt-1 text-foreground">
                The order stays armed and resumes automatically the moment the gate clears (e.g. kill switch
                disengaged or daily limits reset at UTC midnight).
              </div>
            </div>
          )}

          {/* WINDOW_WAITING informational banner */}
          {sl.status === "WINDOW_WAITING" && (
            <div className="rounded-md border border-caution/50 bg-caution/10 p-3 font-mono text-[10px] leading-relaxed text-caution">
              <div className="mb-1 flex items-center gap-1.5 font-semibold tracking-widest">
                <AlertTriangle className="size-3 shrink-0" aria-hidden />
                MONITORING — FINAL ENTRY WINDOW NOT OPEN YET
              </div>
              <div className="text-caution/80">
                This order may only trigger during the final {Math.round((sl.entryWindowMs ?? 0) / 1000)}s before the
                current market settles. Price touches before the window opens are ignored — only live price movement
                inside the active window can fire the order.
              </div>
              <div className="mt-1 text-foreground">
                Window opens in {Math.ceil((sl.entryWindowOpensInMs ?? 0) / 1000)}s — no action needed.
              </div>
            </div>
          )}

          {/* WINDOW_EXPIRED (settlement race) informational banner */}
          {sl.status === "WINDOW_EXPIRED" && (
            <div className="rounded-md border border-caution/50 bg-caution/10 p-3 font-mono text-[10px] leading-relaxed text-caution">
              <div className="mb-1 flex items-center gap-1.5 font-semibold tracking-widest">
                <AlertTriangle className="size-3 shrink-0" aria-hidden />
                MARKET SETTLED BEFORE SUBMISSION
              </div>
              <div className="text-caution/80">
                The trigger was reached, but the market settled before the order could be submitted. No late entries are
                ever placed.
              </div>
              <div className="mt-1 text-foreground">
                The order re-arms automatically when the next market opens — no action needed.
              </div>
            </div>
          )}

          {/* OUT_OF_RANGE diagnostic banner */}
          {sl.status === "OUT_OF_RANGE" && (() => {
            const maj = sl.majorityPrice
            const below = maj < sl.minPrice
            const fix = below
              ? `Lower the Min Price guardrail to $${Math.max(0.01, maj - 0.02).toFixed(2)} or below`
              : `Raise the Max Price guardrail to $${Math.min(0.99, maj + 0.02).toFixed(2)} or above`
            return (
              <div className="rounded-md border border-caution/50 bg-caution/10 p-3 font-mono text-[10px] leading-relaxed text-caution">
                <div className="mb-1 flex items-center gap-1.5 font-semibold tracking-widest">
                  <AlertTriangle className="size-3 shrink-0" aria-hidden />
                  ORDER BLOCKED — MAJORITY PRICE OUTSIDE GUARDRAIL BAND
                </div>
                <div className="text-caution/80">
                  Majority {sl.majoritySide} is ${maj.toFixed(2)},
                  but your guardrail band is ${sl.minPrice.toFixed(2)}–${sl.maxPrice.toFixed(2)}.
                  The order will not execute while the price is {below ? "below" : "above"} the band.
                </div>
                <div className="mt-1 text-foreground">Fix: {fix}</div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act({
                    action: "set_limit_order",
                    limitPrice: sl.limitPrice,
                    limitShares: sl.sizingMode === "FIXED_SHARES" ? sl.sizeValue : sl.shares,
                    triggerPrice: sl.triggerPrice,
                    minPrice: 0.01,
                    maxPrice: 0.99,
                    sizingMode: sl.sizingMode,
                    sizeValue: sl.sizeValue,
                    entryWindowSec: sl.entryWindowMs !== null ? Math.round(sl.entryWindowMs / 1000) : null,
                  })}
                  className="mt-2 flex items-center gap-1.5 rounded border border-caution/50 bg-caution/10 px-2 py-1 text-[10px] tracking-widest text-caution hover:bg-caution/20 disabled:opacity-40"
                >
                  <Zap className="size-3" aria-hidden />
                  WIDEN GUARDRAILS TO $0.01–$0.99
                </button>
              </div>
            )
          })()}

          {/* INSUFFICIENT capital banner */}
          {sl.status === "INSUFFICIENT" && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 font-mono text-[10px] leading-relaxed text-destructive">
              <div className="mb-1 flex items-center gap-1.5 font-semibold tracking-widest">
                <AlertTriangle className="size-3 shrink-0" aria-hidden />
                INSUFFICIENT BALANCE
              </div>
              <div>
                Requires ${(sl.limitPrice * sl.shares).toFixed(2)} but available pool is ${availableCapital.toFixed(2)}.
                Reduce shares or deposit more capital.
              </div>
            </div>
          )}

          {/* Controls: pause/resume + cancel */}
          <div className="mt-1 flex flex-col gap-2">
            {sl.status === "FILLED" && !sl.paused && sl.openPositionCount > 0 && (
              <div className="rounded-md border border-neon/30 bg-neon/5 px-3 py-2 font-mono text-[10px] leading-relaxed text-neon">
                Holding {sl.openPositionCount} {sl.lockedDirection ?? ""} lot{sl.openPositionCount === 1 ? "" : "s"} — engine keeps
                monitoring and will place the next {sl.lockedDirection ?? ""} order on a fresh trigger crossing until this market
                resolves.
              </div>
            )}
            <div className="flex items-center gap-2">
              {sl.paused ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act({ action: "resume_limit_order" })}
                  className="flex flex-1 items-center justify-center gap-2 rounded-md border border-neon/50 bg-neon/5 px-3 py-2 font-mono text-xs text-neon transition-colors hover:bg-neon/10 disabled:opacity-40"
                >
                  <Play className="size-3" aria-hidden />
                  RESUME
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act({ action: "pause_limit_order" })}
                  className="flex flex-1 items-center justify-center gap-2 rounded-md border border-caution/50 bg-caution/5 px-3 py-2 font-mono text-xs text-caution transition-colors hover:bg-caution/10 disabled:opacity-40"
                >
                  <Pause className="size-3" aria-hidden />
                  PAUSE
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void act({ action: "clear_limit_order" })}
                className="flex flex-1 items-center justify-center gap-2 rounded-md border border-destructive/60 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
              >
                <X className="size-3" aria-hidden />
                CANCEL
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Configuration form */
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="TARGET LIMIT PRICE"
              value={target}
              min={0.02}
              max={0.99}
              step={0.01}
              unit="¢"
              help="LIMIT BUY price"
              onCommit={setTarget}
            />
            <NumberField
              label="TRIGGER PRICE"
              value={trigger}
              min={0.01}
              max={0.99}
              step={0.01}
              unit="¢"
              help="Fires the buy (≤ target)"
              onCommit={setTrigger}
            />
          </div>

          {/* Position sizing mode */}
          <fieldset className="rounded-md border border-border/60 p-2">
            <legend className="px-1 font-mono text-[10px] tracking-widest text-muted-foreground">POSITION SIZING</legend>
            <div className="mb-2 grid grid-cols-3 gap-1" role="radiogroup" aria-label="Position sizing mode">
              {(
                [
                  { id: "FIXED_SHARES", label: "SHARES" },
                  { id: "FIXED_USD", label: "DOLLARS" },
                  { id: "PERCENT", label: "% OF POOL" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={sizingMode === m.id}
                  onClick={() => setSizingMode(m.id)}
                  className={`rounded border px-2 py-1.5 font-mono text-[10px] tracking-widest transition-colors ${
                    sizingMode === m.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-muted/10 text-muted-foreground hover:bg-muted/20"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {sizingMode === "FIXED_SHARES" && (
              <NumberField
                label="SHARES"
                value={shares}
                min={snap.config.minShares ?? 5}
                max={10000}
                step={1}
                help={`Min ${snap.config.minShares ?? 5} — same count every order`}
                onCommit={setShares}
              />
            )}
            {sizingMode === "FIXED_USD" && (
              <NumberField
                label="DOLLARS PER ORDER"
                value={usdAmount}
                min={0.05}
                max={100000}
                step={1}
                unit="$"
                help={`≈${estimatedShares} shares at $${target.toFixed(2)}`}
                onCommit={setUsdAmount}
              />
            )}
            {sizingMode === "PERCENT" && (
              <div className="flex flex-col gap-2">
                <NumberField
                  label="PERCENT OF POOL"
                  value={percent}
                  min={1}
                  max={100}
                  step={1}
                  unit="%"
                  help={`≈$${((availableCapital * percent) / 100).toFixed(2)} → ≈${estimatedShares} shares now`}
                  onCommit={setPercent}
                />
                <div className="flex gap-1" aria-label="Percent presets">
                  {PERCENT_PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPercent(p)}
                      className={`flex-1 rounded border px-1 py-1 font-mono text-[10px] tabular-nums transition-colors ${
                        percent === p
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-muted/10 text-muted-foreground hover:bg-muted/20"
                      }`}
                    >
                      {p}%
                    </button>
                  ))}
                </div>
                <p className="font-mono text-[10px] leading-relaxed text-neon/80">
                  Compounding: each order sizes from the pool at fire time, so wins grow the next stake and losses shrink
                  it — automatically, with no manual updates.
                </p>
              </div>
            )}
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="MIN PRICE"
              value={minPrice}
              min={0.01}
              max={0.98}
              step={0.01}
              unit="¢"
              help="Lower guardrail"
              onCommit={setMinPrice}
            />
            <NumberField
              label="MAX PRICE"
              value={maxPrice}
              min={0.02}
              max={0.99}
              step={0.01}
              unit="¢"
              help="Upper guardrail"
              onCommit={setMaxPrice}
            />
          </div>

          {/* Entry time window */}
          <fieldset className="rounded-md border border-border/60 p-2">
            <legend className="px-1 font-mono text-[10px] tracking-widest text-muted-foreground">
              FINAL ENTRY WINDOW (BEFORE SETTLEMENT)
            </legend>
            <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Final entry window before settlement">
              {WINDOW_CHOICES.map((w) => (
                <button
                  key={w}
                  type="button"
                  role="radio"
                  aria-checked={windowSec === w}
                  onClick={() => setWindowSec(w)}
                  className={`rounded border px-1 py-1.5 font-mono text-[10px] tabular-nums transition-colors ${
                    windowSec === w
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-muted/10 text-muted-foreground hover:bg-muted/20"
                  }`}
                >
                  {w === 0 ? "OFF" : `${w}s`}
                </button>
              ))}
            </div>
            <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
              {windowSec === 0
                ? "Disabled — the trigger can fire at any point in the 5-minute market."
                : `This order may only trigger during the final ${windowSec}s before the current market settles. Price touches before the window opens are ignored — re-arms automatically each market.`}
            </p>
          </fieldset>

          {/* Trigger explainer */}
          <div className="grid grid-cols-2 gap-2 font-mono text-xs">
            <div className="rounded border border-caution/30 bg-caution/5 p-2">
              <div className="text-muted-foreground">WHEN MAJORITY @</div>
              <div className="text-base font-semibold tabular-nums text-caution">${trigger.toFixed(2)}</div>
            </div>
            <div className="rounded border border-primary/30 bg-primary/5 p-2">
              <div className="text-muted-foreground">THEN BUY @</div>
              <div className="text-base font-semibold tabular-nums text-primary">${target.toFixed(2)}</div>
            </div>
          </div>

          {/* Capital check */}
          <div
            className={`rounded-md border p-2 font-mono text-xs ${
              canArm ? "border-neon/30 bg-neon/5 text-neon" : "border-destructive/30 bg-destructive/5 text-destructive"
            }`}
          >
            <div className="flex items-center justify-between">
              <span>
                Est. cost: ${requiredCapital.toFixed(2)} ({estimatedShares} sh)
              </span>
              <span>Available: ${availableCapital.toFixed(2)}</span>
            </div>
            {requiredCapital > availableCapital && (
              <div className="mt-1 text-destructive/80">Insufficient balance. Deposit more or reduce the order size.</div>
            )}
            {!sizingValid && sizingMode !== "FIXED_SHARES" && (
              <div className="mt-1 text-destructive/80">
                Order too small: it must afford at least {sizingMode === "FIXED_USD" ? (snap.config.minShares ?? 1) : 1} share
                {(sizingMode === "FIXED_USD" ? (snap.config.minShares ?? 1) : 1) === 1 ? "" : "s"} at the target price.
              </div>
            )}
            {minPrice >= maxPrice && <div className="mt-1 text-destructive/80">Min price must be below max price.</div>}
            {!triggerValid && (
              <div className="mt-1 text-destructive/80">Trigger must be above $0.00 and at or below the target.</div>
            )}
          </div>

          <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
            Monitors the live majority side (higher-priced contract). When the price reaches your Trigger Price, it submits a
            LIMIT BUY at the Target Limit Price. The FIRST fill locks the direction for the whole 5-minute market — every
            subsequent order uses that same side (on a fresh trigger crossing) until the next market resets it. It never buys
            the minority side after locking, never buys early, and never double-submits. Independent of the strategy engine and
            time window.
          </p>

          <button
            type="button"
            disabled={busy || !canArm}
            onClick={() =>
              void act({
                action: "set_limit_order",
                limitPrice: target,
                limitShares: shares,
                minPrice,
                maxPrice,
                triggerPrice: trigger,
                sizingMode,
                sizeValue: sizingMode === "FIXED_USD" ? usdAmount : sizingMode === "PERCENT" ? percent : shares,
                entryWindowSec: windowSec === 0 ? null : windowSec,
              })
            }
            className={`flex items-center justify-center gap-2 rounded-md border px-3 py-3 font-mono text-sm transition-colors ${
              canArm
                ? "border-primary bg-primary/10 text-primary hover:bg-primary/20"
                : "cursor-not-allowed border-muted bg-muted/10 text-muted-foreground"
            } disabled:opacity-40`}
          >
            <Crosshair className="size-4" aria-hidden />
            {canArm ? "ARM STANDING ORDER" : "CHECK PARAMETERS"}
          </button>
        </div>
      )}
    </section>
  )
}
