"use client"

import { useEffect, useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"

interface Props {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  unit?: string
  help?: string
  onCommit: (value: number) => void
}

/**
 * Precise numeric input with step arrows — the slider replacement
 * mandated by the spec. Commits on blur, Enter, or arrow tap so the
 * engine only receives clean, validated values.
 */
export function NumberField({ label, value, min = 0, max = Number.POSITIVE_INFINITY, step = 0.01, unit, help, onCommit }: Props) {
  const [draft, setDraft] = useState(String(value))

  // Keep the local draft synced when the authoritative value changes.
  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const clamp = (n: number) => Math.min(Math.max(n, min), max)
  const round = (n: number) => {
    const decimals = (String(step).split(".")[1] ?? "").length
    return Number(clamp(n).toFixed(decimals))
  }

  const commit = (raw: string) => {
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    const next = round(n)
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }

  const nudge = (dir: 1 | -1) => {
    const next = round(value + dir * step)
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] tracking-widest text-muted-foreground">{label}</span>
      <div className="flex items-stretch rounded-md border border-border bg-input focus-within:border-neon">
        {unit ? <span className="flex items-center pl-2 font-mono text-xs text-muted-foreground">{unit}</span> : null}
        <input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit((e.target as HTMLInputElement).value)
            }
          }}
          aria-label={label}
          className="w-full bg-transparent px-2 py-2 font-mono text-sm tabular-nums text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <div className="flex flex-col border-l border-border">
          <button
            type="button"
            tabIndex={-1}
            onClick={() => nudge(1)}
            aria-label={`Increase ${label}`}
            className="flex flex-1 items-center px-1 text-muted-foreground transition-colors hover:bg-neon/10 hover:text-neon"
          >
            <ChevronUp className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => nudge(-1)}
            aria-label={`Decrease ${label}`}
            className="flex flex-1 items-center px-1 text-muted-foreground transition-colors hover:bg-neon/10 hover:text-neon"
          >
            <ChevronDown className="size-3" aria-hidden />
          </button>
        </div>
      </div>
      {help ? <span className="font-mono text-[10px] leading-relaxed text-muted-foreground">{help}</span> : null}
    </label>
  )
}
