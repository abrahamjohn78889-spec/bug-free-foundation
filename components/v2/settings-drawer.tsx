"use client"

import { useEffect, useState } from "react"
import { Settings2, X } from "lucide-react"
import { useUiSettings, type UiSettings } from "./use-ui-settings"

/**
 * SettingsDrawer — right-anchored panel with UI-only preferences.
 * Never touches trading logic; only writes to localStorage and toggles
 * body classes read by globals.css.
 */
export function SettingsDrawer() {
  const [open, setOpen] = useState(false)
  const [s, update] = useUiSettings()

  // ESC to close, focus trap-lite.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open display settings"
        className="flex items-center justify-center rounded-md border border-border bg-secondary/60 p-1.5 text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
      >
        <Settings2 className="size-3.5" aria-hidden="true" />
      </button>

      {open ? (
        <>
          <div
            className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Display settings"
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-l border-border bg-card shadow-2xl"
          >
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="font-mono text-[11px] tracking-widest text-muted-foreground">DISPLAY SETTINGS</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close settings"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </header>

            <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4 font-mono text-xs">
              <Segmented
                label="THEME"
                hint="Dark ink terminal or bright daylight surface."
                value={s.theme}
                options={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                ]}
                onChange={(v) => update({ theme: v as UiSettings["theme"] })}
              />

              <Segmented
                label="DENSITY"
                hint="Row and font size across tables and panels."
                value={s.density}
                options={[
                  { value: "comfortable", label: "Comfortable" },
                  { value: "compact", label: "Compact" },
                ]}
                onChange={(v) => update({ density: v as UiSettings["density"] })}
              />


              <Toggle
                label="AMBIENT BACKGROUND"
                hint="Subtle grid + vignette behind the UI."
                value={s.ambient}
                onChange={(v) => update({ ambient: v })}
              />

              <Segmented
                label="WALLPAPER"
                hint="Optional atmospheric layer. Auto-off in Compact mode."
                value={s.wallpaper}
                options={[
                  { value: "none", label: "None" },
                  { value: "cyber", label: "Cyber Terminal" },
                ]}
                onChange={(v) => update({ wallpaper: v as UiSettings["wallpaper"] })}
              />

              <Toggle
                label="ANIMATIONS"
                hint="Disable all transitions for maximum performance."
                value={s.motion}
                onChange={(v) => update({ motion: v })}
              />

              <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 leading-relaxed text-muted-foreground">
                Preferences are stored locally in this browser only. Trading
                logic, keys, and pipeline behavior are never affected.
              </div>
            </div>
          </aside>
        </>
      ) : null}
    </>
  )
}

function Segmented<T extends string>({
  label, hint, value, options, onChange,
}: {
  label: string
  hint?: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="space-y-2">
      <div>
        <div className="tracking-widest text-muted-foreground">{label}</div>
        {hint ? <div className="mt-0.5 normal-case text-[11px] text-muted-foreground/70">{hint}</div> : null}
      </div>
      <div className="inline-flex rounded-md border border-border bg-secondary/50 p-0.5">
        {options.map((o) => {
          const active = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={`rounded-[4px] px-3 py-1 text-[11px] tracking-wider transition-colors ${
                active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Toggle({
  label, hint, value, onChange,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="tracking-widest text-muted-foreground">{label}</div>
        {hint ? <div className="mt-0.5 normal-case text-[11px] text-muted-foreground/70">{hint}</div> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
          value ? "border-primary bg-primary/70" : "border-border bg-secondary"
        }`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-foreground transition-transform ${
            value ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  )
}
