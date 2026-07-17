"use client"

import { useState } from "react"
import { CheckCircle2, Circle, ListChecks, Power, RefreshCw, Zap } from "lucide-react"
import type { EngineSnapshot, StrategyId } from "@/lib/v2/engine/types"
import type { PreflightReport } from "@/lib/v2/engine/preflight"
import { sendControl, useStrategies } from "./use-bot"
import { NumberField } from "./number-field"

const P1_WINDOW_OPTIONS: { value: number; label: string; description: string }[] = [
  { value: 0, label: "DISABLED", description: "No time windows — trade anytime" },
  { value: 5_000, label: "5s", description: "5-second window before market event" },
  { value: 15_000, label: "15s", description: "15-second window" },
  { value: 30_000, label: "30s", description: "30-second window" },
  { value: 60_000, label: "60s", description: "60-second window" },
  { value: 90_000, label: "90s", description: "90-second window" },
  { value: 120_000, label: "120s", description: "120-second window" },
  { value: 180_000, label: "180s", description: "180-second window (default T-20s is 20000ms)" },
]

const statusColor: Record<string, string> = {
  PASS: "text-neon",
  WARN: "text-caution",
  FAIL: "text-crimson",
  SKIP: "text-muted-foreground",
}

interface Props {
  snap: EngineSnapshot
  onChanged: () => void
}

export function CommandDeck({ snap, onChanged }: Props) {
  const [balanceInput, setBalanceInput] = useState("")
  const [feedback, setFeedback] = useState<string | null>(null)
  const [lastActionFailed, setLastActionFailed] = useState(false)
  const [preflight, setPreflight] = useState<PreflightReport | null>(null)
  const [preflightBusy, setPreflightBusy] = useState(false)
  const [gridActive, setGridActive] = useState(false)
  const [rangeActive, setRangeActive] = useState(false)

  const { data: stratData } = useStrategies()
  const strategies = stratData?.strategies ?? []

  const p1 = snap.config.p1Band
  const p2 = snap.config.p2Band

  const act = async (body: Record<string, unknown>) => {
    const res = await sendControl(body)
    setFeedback(res.message)
    setLastActionFailed(!res.ok)
    if (!res.ok) {
      console.error("[command-deck] Control action failed:", res.message)
    }
    onChanged()
  }

  const activateStrategy = async (id: StrategyId | null) => {
    const res = await sendControl({ action: "set_strategy", strategy: id })
    setFeedback(res.message)
    onChanged()
  }

  const runPreflightCheck = async () => {
    setPreflightBusy(true)
    try {
      const res = await fetch("/api/v2/bot/preflight", { cache: "no-store" })
      setPreflight((await res.json()) as PreflightReport)
    } catch {
      setFeedback("Preflight request failed")
    } finally {
      setPreflightBusy(false)
    }
  }

  return (
    <section aria-label="Operation Deck" className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <header className="flex items-center justify-between">
        <h2 className="font-mono text-sm tracking-widest text-muted-foreground">TACTICAL OPERATION DECK</h2>
        <span
          className={`rounded px-2 py-0.5 font-mono text-xs ${
            snap.running ? "bg-neon/15 text-neon text-glow-neon" : "bg-crimson/15 text-crimson"
          }`}
        >
          {snap.running ? "ENGINE LIVE" : "ENGINE COLD"}
        </span>
      </header>

      {/* Primary engine banner — the Standing Limit Order always has top priority
          and runs independently of any registry strategy. */}
      <div className="flex items-start gap-2 rounded-md border border-neon/50 bg-neon/5 px-3 py-2.5">
        <Zap className="mt-0.5 size-4 shrink-0 text-neon" aria-hidden />
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold tracking-widest text-neon">PRIMARY ENGINE — STANDING LIMIT ORDER</span>
            <span className="rounded bg-neon/15 px-1.5 py-0.5 font-mono text-[9px] tracking-widest text-neon">
              HIGHEST PRIORITY
            </span>
          </div>
          <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
            Runs independently of every registry strategy and cannot be overridden or paused by them. Configure it in the
            panel to the right. Registry strategies below are optional and disabled by default.
          </p>
        </div>
      </div>

      {/* pipeline hot-swap */}
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] tracking-widest text-muted-foreground">EXECUTION PIPELINE</span>
        <div className="flex items-center gap-2" role="group" aria-label="Pipeline selector">
          {/* One shared engine, one interchangeable execution backend:
              PAPER_V1 = simulated execution against live CLOB data,
              LIVE_V2  = real wallet → real SDK → real Polymarket CLOB. */}
          {(["PAPER_V1", "LIVE_V2"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => act({ action: "set_mode", mode: m })}
              disabled={snap.running}
              className={`flex-1 rounded-md border px-3 py-2 font-mono text-xs transition-colors disabled:opacity-50 ${
                snap.mode === m
                  ? m === "PAPER_V1"
                    ? "border-neon bg-neon/10 text-neon glow-neon"
                    : "border-crimson bg-crimson/10 text-crimson glow-crimson"
                  : "border-border bg-secondary text-muted-foreground hover:text-foreground"
              }`}
              aria-pressed={snap.mode === m}
            >
              {m === "PAPER_V1" ? "V1 PAPER" : "V2 LIVE"}
            </button>
          ))}
        </div>
      </div>

      {/* ignition */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => act({ action: "start" })}
          disabled={snap.running && !lastActionFailed}
          className={`flex flex-1 items-center justify-center gap-2 rounded-md border border-neon bg-neon/10 px-3 py-3 font-mono text-sm text-neon transition-colors hover:bg-neon/20 disabled:opacity-40 ${
            snap.running && !lastActionFailed ? "glow-neon" : ""
          }`}
        >
          <Zap className="size-4" aria-hidden />
          START ENGINE
        </button>
        <button
          type="button"
          onClick={() => act({ action: "stop" })}
          disabled={!snap.running}
          className={`flex flex-1 items-center justify-center gap-2 rounded-md border border-crimson bg-crimson/10 px-3 py-3 font-mono text-sm text-crimson transition-colors hover:bg-crimson/20 disabled:opacity-40 ${
            snap.running ? "glow-crimson" : ""
          }`}
        >
          <Power className="size-4" aria-hidden />
          EMERGENCY STOP
        </button>
      </div>

      {/* preflight */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void runPreflightCheck()}
          disabled={preflightBusy}
          className="flex items-center justify-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 font-mono text-xs text-foreground transition-colors hover:border-neon hover:text-neon disabled:opacity-40"
        >
          <ListChecks className="size-4" aria-hidden />
          {preflightBusy ? "RUNNING CHECKS..." : "PREFLIGHT CHECK"}
        </button>
        {preflight ? (
          <div
            className={`flex flex-col gap-1 rounded-md border p-3 font-mono text-xs ${
              preflight.ready ? "border-neon/50 bg-neon/5" : "border-crimson/50 bg-crimson/5"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="tracking-widest text-muted-foreground">READINESS</span>
              <span className={preflight.ready ? "text-neon text-glow-neon" : "text-crimson text-glow-crimson"}>
                {preflight.ready ? "GO FOR IGNITION" : "NO-GO"}
              </span>
            </div>
            <ul className="mt-1 flex flex-col gap-1">
              {preflight.checks.map((c) => (
                <li key={c.id} className="flex items-baseline justify-between gap-2">
                  <span className="text-muted-foreground">{c.label}</span>
                  <span className={statusColor[c.status] ?? "text-muted-foreground"} title={c.detail}>
                    {c.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {/* simulation funding box */}
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          const amt = Number(balanceInput)
          if (Number.isFinite(amt) && amt > 0) void act({ action: "set_balance", amount: amt })
        }}
      >
        <span className="font-mono text-[10px] tracking-widest text-muted-foreground">V1 SIMULATION FUNDING</span>
        <div className="flex gap-2">
          <input
            type="number"
            min={1}
            step="0.01"
            value={balanceInput}
            onChange={(e) => setBalanceInput(e.target.value)}
            placeholder="Set / reset paper balance ($)"
            aria-label="Paper testing balance in dollars"
            className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:border-neon focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-md border border-border bg-secondary px-4 py-2 font-mono text-xs text-foreground transition-colors hover:border-neon hover:text-neon"
          >
            SET
          </button>
        </div>
      </form>

      {/* P1 Window selector */}
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] tracking-widest text-muted-foreground">P1 TIME WINDOW</span>
        <div className="flex flex-wrap gap-1" role="group" aria-label="P1 window selector">
          {P1_WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              title={opt.description}
              onClick={() => void act({ action: "set_p1_window", p1WindowMs: opt.value })}
              className={`rounded-md border px-2.5 py-1.5 font-mono text-xs transition-colors ${
                snap.config.p1WindowMs === opt.value
                  ? "border-neon bg-neon/10 text-neon glow-neon"
                  : "border-border bg-secondary text-muted-foreground hover:text-foreground"
              }`}
              aria-pressed={snap.config.p1WindowMs === opt.value}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          {P1_WINDOW_OPTIONS.find((o) => o.value === snap.config.p1WindowMs)?.description}
        </p>
      </div>

      {/* Strategy Quick-Switcher */}
      <div className="flex flex-col gap-3 rounded-md border border-border bg-secondary/40 p-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs tracking-widest text-muted-foreground">
            OPTIONAL SECONDARY STRATEGY
          </span>
          {snap.running ? (
            <span className="font-mono text-[9px] text-caution">STOP ENGINE TO SWITCH</span>
          ) : (
            <span className="font-mono text-[9px] text-primary">ENGINE COLD — SWITCHING ENABLED</span>
          )}
        </div>
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          Disabled by default (NONE). These registry edges are optional and run alongside — never ahead of — the Standing
          Limit Order. Leave on NONE to run the Standing Limit Order exclusively.
        </p>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Strategy selector">
          {/* NONE button — deselect all strategies, leaving only SLO */}
          <button
            type="button"
            disabled={snap.running || snap.activeStrategy === null}
            title={
              snap.activeStrategy === null
                ? "No strategy is active — Standing Limit Order only"
                : snap.running
                  ? "Stop the engine first to switch strategies"
                  : "Deselect all strategies — Standing Limit Order only"
            }
            onClick={() => void activateStrategy(null)}
            aria-pressed={snap.activeStrategy === null}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[10px] transition-colors ${
              snap.activeStrategy === null
                ? "border-neon bg-neon/10 text-neon"
                : snap.running
                  ? "cursor-not-allowed border-border bg-secondary text-muted-foreground opacity-40"
                  : "border-primary/50 bg-primary/5 text-primary hover:bg-primary/15"
            }`}
          >
            {snap.activeStrategy === null ? (
              <CheckCircle2 className="size-3 shrink-0" aria-hidden />
            ) : (
              <Circle className="size-3 shrink-0" aria-hidden />
            )}
            <span>NONE</span>
          </button>

          {strategies.length > 0
            ? strategies.map((s) => {
                const isActive = s.id === snap.activeStrategy
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={snap.running || isActive}
                    title={
                      isActive
                        ? `${s.name} — currently active`
                        : snap.running
                          ? "Stop the engine first to switch strategies"
                          : `Activate ${s.name}`
                    }
                    onClick={() => void activateStrategy(s.id as StrategyId)}
                    aria-pressed={isActive}
                    className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[10px] transition-colors ${
                      isActive
                        ? "border-neon bg-neon/10 text-neon"
                        : snap.running
                          ? "cursor-not-allowed border-border bg-secondary text-muted-foreground opacity-40"
                          : "border-primary/50 bg-primary/5 text-primary hover:bg-primary/15"
                    }`}
                  >
                    {isActive ? (
                      <CheckCircle2 className="size-3 shrink-0" aria-hidden />
                    ) : (
                      <Circle className="size-3 shrink-0" aria-hidden />
                    )}
                    <span>{s.code}</span>
                  </button>
                )
              })
            : /* skeleton while loading */
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-7 w-16 animate-pulse rounded-md bg-muted" aria-hidden />
              ))}
        </div>
        {strategies.length > 0 && (
          <p className="font-mono text-[10px] text-muted-foreground">
            Active:{" "}
            <span className="text-neon">
              {snap.activeStrategy === null
                ? "None (Standing Limit Order only)"
                : strategies.find((s) => s.id === snap.activeStrategy)?.name ?? snap.activeStrategy}
            </span>
          </p>
        )}
      </div>

      {/* Target Grid Configurator — numeric, no sliders */}
      <div
        className={`flex flex-col gap-3 rounded-md border p-3 transition-colors ${
          gridActive ? "border-neon/50 bg-neon/5" : "border-border bg-secondary/40"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs tracking-widest text-muted-foreground">TARGET GRID CONFIGURATOR</span>
          <button
            type="button"
            onClick={() => setGridActive((v) => !v)}
            aria-pressed={gridActive}
            title={gridActive ? "Deactivate Target Grid overrides" : "Activate Target Grid price boundaries"}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] transition-colors ${
              gridActive
                ? "border-neon bg-neon/10 text-neon"
                : "border-primary/50 bg-primary/5 text-primary hover:bg-primary/15"
            }`}
          >
            {gridActive ? <CheckCircle2 className="size-3" aria-hidden /> : <Circle className="size-3" aria-hidden />}
            {gridActive ? "ACTIVE" : "ACTIVATE"}
          </button>
        </div>
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          Exact penny boundaries for the cascading sniper. Priority 1 hunts cheap liquidity (T-20s..T-11s); Priority 2 is
          the certainty window (T-10s..T-3s).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="PRIORITY 1 FLOOR"
            value={p1.min}
            min={0.5}
            max={0.99}
            step={0.01}
            unit="$"
            onCommit={(v) => void act({ action: "set_bands", p1: { min: v, max: p1.max } })}
          />
          <NumberField
            label="PRIORITY 1 CEILING"
            value={p1.max}
            min={0.5}
            max={0.99}
            step={0.01}
            unit="$"
            onCommit={(v) => void act({ action: "set_bands", p1: { min: p1.min, max: v } })}
          />
          <NumberField
            label="PRIORITY 2 FLOOR"
            value={p2.min}
            min={0.5}
            max={0.99}
            step={0.01}
            unit="$"
            onCommit={(v) => void act({ action: "set_bands", p2: { min: v, max: p2.max } })}
          />
          <NumberField
            label="PRIORITY 2 CEILING"
            value={p2.max}
            min={0.5}
            max={0.99}
            step={0.01}
            unit="$"
            onCommit={(v) => void act({ action: "set_bands", p2: { min: p2.min, max: v } })}
          />
        </div>
      </div>

      {/* price range constraint — numeric */}
      <div
        className={`flex flex-col gap-3 rounded-md border p-3 transition-colors ${
          rangeActive ? "border-neon/50 bg-neon/5" : "border-border bg-secondary/40"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs tracking-widest text-muted-foreground">ABSOLUTE PRICE RANGE CONSTRAINT</span>
          <button
            type="button"
            onClick={() => setRangeActive((v) => !v)}
            aria-pressed={rangeActive}
            title={rangeActive ? "Deactivate price range constraint" : "Activate hard price floor/ceiling guard"}
            className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] transition-colors ${
              rangeActive
                ? "border-neon bg-neon/10 text-neon"
                : "border-primary/50 bg-primary/5 text-primary hover:bg-primary/15"
            }`}
          >
            {rangeActive ? <CheckCircle2 className="size-3" aria-hidden /> : <Circle className="size-3" aria-hidden />}
            {rangeActive ? "ACTIVE" : "ACTIVATE"}
          </button>
        </div>
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          Orders are rejected if the execution price falls outside this hard window.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="FLOOR"
            value={snap.config.priceFloor ?? 0.75}
            min={0.01}
            max={0.97}
            step={0.01}
            unit="$"
            onCommit={(v) => void act({ action: "set_price_range", priceFloor: v, priceCeil: snap.config.priceCeil ?? 0.99 })}
          />
          <NumberField
            label="CEILING"
            value={snap.config.priceCeil ?? 0.99}
            min={0.02}
            max={0.99}
            step={0.01}
            unit="$"
            onCommit={(v) => void act({ action: "set_price_range", priceFloor: snap.config.priceFloor ?? 0.75, priceCeil: v })}
          />
        </div>
      </div>

      {feedback ? (
        <p
          className={`font-mono text-xs ${
            feedback.toLowerCase().includes("error") ||
            feedback.toLowerCase().includes("failed") ||
            feedback.toLowerCase().includes("no-go")
              ? "text-crimson"
              : "text-muted-foreground"
          }`}
        >
          &gt; {feedback}
        </p>
      ) : null}
    </section>
  )
}
