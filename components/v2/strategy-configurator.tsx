"use client"

import { useState } from "react"
import { CheckCircle2, Circle, Cpu, FlaskConical } from "lucide-react"
import type { EngineSnapshot } from "@/lib/v2/engine/types"
import type { StrategyMeta, StrategyParam } from "@/lib/v2/engine/strategy-registry/types"
import { sendControl, useStrategies } from "./use-bot"
import { NumberField } from "./number-field"

interface Props {
  snap: EngineSnapshot
  onChanged: () => void
}

export function StrategyConfigurator({ snap, onChanged }: Props) {
  const { data } = useStrategies()
  const strategies = data?.strategies ?? []
  const [feedback, setFeedback] = useState<string | null>(null)

  const active = snap.activeStrategy
  const paramsFor = (id: string): Record<string, number | boolean | string> =>
    (snap.config.strategyParams?.[id as keyof typeof snap.config.strategyParams] as Record<string, number | boolean | string>) ?? {}

  const activate = async (id: string) => {
    const res = await sendControl({ action: "set_strategy", strategy: id })
    setFeedback(res.message)
    onChanged()
  }

  const updateParam = async (id: string, key: string, value: number | boolean | string) => {
    const res = await sendControl({ action: "set_strategy_params", strategy: id, params: { [key]: value } })
    setFeedback(res.message)
    onChanged()
  }

  return (
    <section aria-label="Strategy Configurator" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-mono text-sm tracking-widest text-muted-foreground">
          <Cpu className="size-4" aria-hidden /> QUANT STRATEGY CONFIGURATOR
        </h2>
        <div className="flex items-center gap-2">
          <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">
            PAPER TRADING ENABLED
          </span>
          {snap.running ? (
            <span className="rounded bg-caution/15 px-2 py-0.5 font-mono text-[10px] text-caution">
              STOP ENGINE TO SWITCH EDGE
            </span>
          ) : null}
        </div>
      </header>

      <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
        Exactly one edge is routed into the active pipeline. Parameters can be fine-tuned live; the active edge can only be
        swapped while the engine is cold. All strategies run in paper simulation — no real funds at risk.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        {strategies.map((s) => (
          <StrategyCard
            key={s.id}
            meta={s}
            isActive={s.id === active}
            params={paramsFor(s.id)}
            canActivate={!snap.running}
            onActivate={() => void activate(s.id)}
            onParam={(key, value) => void updateParam(s.id, key, value)}
          />
        ))}
      </div>

      {feedback ? <p className="font-mono text-xs text-muted-foreground">&gt; {feedback}</p> : null}
    </section>
  )
}

function StrategyCard({
  meta,
  isActive,
  params,
  canActivate,
  onActivate,
  onParam,
}: {
  meta: StrategyMeta
  isActive: boolean
  params: Record<string, number | boolean | string>
  canActivate: boolean
  onActivate: () => void
  onParam: (key: string, value: number | boolean | string) => void
}) {
  return (
    <article
      className={`flex flex-col gap-3 rounded-lg border p-4 transition-colors ${
        isActive ? "border-neon bg-neon/5 glow-neon" : "border-border bg-card"
      }`}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className={`font-mono text-xs tracking-widest ${isActive ? "text-neon text-glow-neon" : "text-foreground"}`}>
              {meta.code}
            </span>
            {meta.liveReady ? (
              <span className="rounded bg-neon/15 px-1.5 py-0.5 font-mono text-[9px] text-neon">LIVE-READY</span>
            ) : (
              <span
                title="This strategy runs in paper simulation mode only. Paper trading is fully enabled."
                className="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary"
              >
                <FlaskConical className="size-2.5" aria-hidden /> SIM-ONLY
              </span>
            )}
          </div>
          <h3 className="text-pretty font-mono text-sm text-foreground">{meta.name}</h3>
          <p className="font-mono text-[10px] text-muted-foreground">{meta.tagline}</p>
        </div>
        <button
          type="button"
          onClick={onActivate}
          disabled={isActive || !canActivate}
          title={
            isActive
              ? "This strategy is currently active"
              : !canActivate
                ? "Stop the engine first to switch strategies"
                : "Click to activate this strategy"
          }
          aria-pressed={isActive}
          className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] transition-colors ${
            isActive
              ? "border-neon bg-neon/10 text-neon"
              : canActivate
                ? "border-primary/60 bg-primary/5 text-primary hover:bg-primary/15"
                : "border-border bg-secondary text-muted-foreground opacity-40 cursor-not-allowed"
          }`}
        >
          {isActive ? <CheckCircle2 className="size-3" aria-hidden /> : <Circle className="size-3" aria-hidden />}
          {isActive ? "ACTIVE" : "ACTIVATE"}
        </button>
      </header>

      <p className="text-pretty font-mono text-[11px] leading-relaxed text-muted-foreground">{meta.description}</p>

      {meta.params.length > 0 ? (
        <div className="grid gap-3 border-t border-border/60 pt-3 sm:grid-cols-2">
          {meta.params.map((p) => (
            <ParamControl key={p.key} param={p} value={params[p.key] ?? p.default} onCommit={(v) => onParam(p.key, v)} />
          ))}
        </div>
      ) : (
        <p className="border-t border-border/60 pt-3 font-mono text-[10px] text-muted-foreground">
          No tunable parameters — fully autonomous edge.
        </p>
      )}
    </article>
  )
}

function ParamControl({
  param,
  value,
  onCommit,
}: {
  param: StrategyParam
  value: number | boolean | string
  onCommit: (value: number | boolean | string) => void
}) {
  if (param.kind === "toggle") {
    const on = Boolean(value)
    return (
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10px] tracking-widest text-muted-foreground">{param.label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => onCommit(!on)}
          className={`flex items-center justify-between rounded-md border px-2 py-2 font-mono text-xs transition-colors ${
            on ? "border-neon bg-neon/10 text-neon" : "border-border bg-secondary text-muted-foreground"
          }`}
        >
          <span>{on ? "ENABLED" : "DISABLED"}</span>
          <span className={`h-3 w-3 rounded-full ${on ? "bg-neon" : "bg-muted-foreground"}`} aria-hidden />
        </button>
        {param.help ? <span className="font-mono text-[10px] leading-relaxed text-muted-foreground">{param.help}</span> : null}
      </div>
    )
  }

  if (param.kind === "select") {
    return (
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] tracking-widest text-muted-foreground">{param.label}</span>
        <select
          value={String(value)}
          onChange={(e) => onCommit(e.target.value)}
          className="rounded-md border border-border bg-input px-2 py-2 font-mono text-sm text-foreground outline-none focus:border-neon"
        >
          {param.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {param.help ? <span className="font-mono text-[10px] leading-relaxed text-muted-foreground">{param.help}</span> : null}
      </label>
    )
  }

  return (
    <NumberField
      label={param.label}
      value={Number(value)}
      min={param.min}
      max={param.max}
      step={param.step ?? 0.01}
      unit={param.unit}
      help={param.help}
      onCommit={onCommit}
    />
  )
}
