"use client"

/**
 * STRATEGY PROFILES + A/B COMPARISON
 *
 * Rendered inside the Strategies tab, below the strategy configurator.
 * All mutations go through /api/v2/bot/profiles (session + control token).
 * Loading a profile applies settings only — it NEVER starts the engine.
 */

import { useState } from "react"
import { ArrowLeftRight, BookMarked, Check, Copy, Download, FolderOpen, Pencil, Plus, Save, Trash2, X } from "lucide-react"
import { sendProfileAction, useComparison, useProfiles } from "./use-bot"

interface Props {
  running: boolean
  onChanged: () => void
}

function fmtTs(ms: number | null): string {
  if (!ms) return "never"
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"
}

export function ProfilesPanel({ running, onChanged }: Props) {
  const { data, mutate } = useProfiles()
  const profiles = data?.profiles ?? []
  const activeProfile = data?.activeProfile ?? null

  const [feedback, setFeedback] = useState<string | null>(null)
  const [newName, setNewName] = useState("")
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [notesFor, setNotesFor] = useState<string | null>(null)
  const [notesValue, setNotesValue] = useState("")
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Comparison selectors
  const [compareA, setCompareA] = useState<string>("")
  const [compareB, setCompareB] = useState<string>("")
  const comparison = useComparison(compareA || null, compareB && compareB !== compareA ? compareB : null)

  const act = async (body: Record<string, unknown>) => {
    setBusy(true)
    const res = await sendProfileAction(body)
    setFeedback(res.message)
    await mutate()
    onChanged()
    setBusy(false)
    return res
  }

  const submitCreate = async () => {
    if (!newName.trim()) return
    const res = await act({ action: "create", name: newName.trim() })
    if (res.ok) setNewName("")
  }

  return (
    <section aria-label="Strategy profiles" className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-mono text-[10px] tracking-widest text-muted-foreground">
            <BookMarked className="size-3.5" aria-hidden />
            STRATEGY PROFILES
          </h3>
          {running ? (
            <span className="rounded bg-caution/15 px-2 py-0.5 font-mono text-[10px] text-caution">
              STOP ENGINE TO LOAD A PROFILE
            </span>
          ) : null}
        </header>

        {/* Create from current configuration */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label htmlFor="profile-new-name" className="sr-only">
            New profile name
          </label>
          <input
            id="profile-new-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) void submitCreate()
            }}
            placeholder="Name current configuration…"
            maxLength={64}
            className="h-8 min-w-0 flex-1 rounded border border-border bg-background px-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            onClick={() => void submitCreate()}
            disabled={busy || !newName.trim()}
            className="flex h-8 items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 font-mono text-[10px] tracking-widest text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
          >
            <Plus className="size-3" aria-hidden />
            SAVE CURRENT AS PROFILE
          </button>
        </div>

        {feedback ? (
          <p role="status" className="mb-3 rounded border border-border bg-muted/30 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
            {feedback}
          </p>
        ) : null}

        {/* Profile list */}
        {profiles.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">
            No saved profiles yet. Configure the strategy, bands, sizing, and risk settings, then save them as a named
            profile (e.g. &quot;Conservative&quot;, &quot;Aggressive&quot;, &quot;Experimental&quot;).
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {profiles.map((p) => {
              const isActive = p.name === activeProfile
              return (
                <li key={p.id} className={`rounded border p-3 ${isActive ? "border-neon/40 bg-neon/5" : "border-border bg-background"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {renaming === p.name ? (
                        <span className="flex items-center gap-1">
                          <label htmlFor={`rename-${p.id}`} className="sr-only">
                            Rename profile {p.name}
                          </label>
                          <input
                            id={`rename-${p.id}`}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                                void act({ action: "rename", name: p.name, newName: renameValue.trim() }).then(() => setRenaming(null))
                              }
                              if (e.key === "Escape") setRenaming(null)
                            }}
                            maxLength={64}
                            className="h-7 w-44 rounded border border-border bg-background px-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                          />
                          <button
                            type="button"
                            aria-label="Confirm rename"
                            onClick={() => void act({ action: "rename", name: p.name, newName: renameValue.trim() }).then(() => setRenaming(null))}
                            className="rounded p-1 text-neon hover:bg-muted/50"
                          >
                            <Check className="size-3.5" aria-hidden />
                          </button>
                          <button type="button" aria-label="Cancel rename" onClick={() => setRenaming(null)} className="rounded p-1 text-muted-foreground hover:bg-muted/50">
                            <X className="size-3.5" aria-hidden />
                          </button>
                        </span>
                      ) : (
                        <span className="truncate font-mono text-sm text-foreground">{p.name}</span>
                      )}
                      {isActive ? (
                        <span className="rounded bg-neon/15 px-1.5 py-0.5 font-mono text-[9px] tracking-widest text-neon">ACTIVE</span>
                      ) : null}
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {p.config.activeStrategy ?? "no strategy"} · {p.config.mode}
                      </span>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void act({ action: "load", name: p.name })}
                        disabled={busy || running}
                        title={running ? "Stop the engine first" : "Apply this profile's settings (does not start the engine)"}
                        className="flex h-7 items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2 font-mono text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
                      >
                        <FolderOpen className="size-3" aria-hidden />
                        LOAD
                      </button>
                      <button
                        type="button"
                        onClick={() => void act({ action: "save", name: p.name })}
                        disabled={busy}
                        title="Overwrite this profile with the current configuration"
                        aria-label={`Overwrite ${p.name} with current configuration`}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
                      >
                        <Save className="size-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRenaming(p.name)
                          setRenameValue(p.name)
                        }}
                        disabled={busy}
                        aria-label={`Rename ${p.name}`}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
                      >
                        <Pencil className="size-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => void act({ action: "duplicate", name: p.name, newName: `${p.name} (copy)` })}
                        disabled={busy}
                        aria-label={`Duplicate ${p.name}`}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
                      >
                        <Copy className="size-3.5" aria-hidden />
                      </button>
                      {confirmDelete === p.name ? (
                        <span className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void act({ action: "delete", name: p.name }).then(() => setConfirmDelete(null))}
                            className="rounded border border-crimson/40 bg-crimson/10 px-2 py-1 font-mono text-[10px] text-crimson hover:bg-crimson/20"
                          >
                            CONFIRM
                          </button>
                          <button type="button" aria-label="Cancel delete" onClick={() => setConfirmDelete(null)} className="rounded p-1 text-muted-foreground hover:bg-muted/50">
                            <X className="size-3.5" aria-hidden />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(p.name)}
                          disabled={busy}
                          aria-label={`Delete ${p.name}`}
                          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-crimson/10 hover:text-crimson disabled:opacity-40"
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Notes */}
                  {notesFor === p.name ? (
                    <div className="mt-2 flex items-start gap-2">
                      <label htmlFor={`notes-${p.id}`} className="sr-only">
                        Notes for {p.name}
                      </label>
                      <textarea
                        id={`notes-${p.id}`}
                        value={notesValue}
                        onChange={(e) => setNotesValue(e.target.value)}
                        rows={2}
                        maxLength={500}
                        className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        placeholder="Why this profile exists, when to use it…"
                      />
                      <button
                        type="button"
                        onClick={() => void act({ action: "set_notes", name: p.name, notes: notesValue }).then(() => setNotesFor(null))}
                        className="rounded border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-[10px] text-primary hover:bg-primary/20"
                      >
                        SAVE
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setNotesFor(p.name)
                        setNotesValue(p.notes)
                      }}
                      className="mt-1.5 block max-w-full truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {p.notes ? `“${p.notes}”` : "+ add notes"}
                    </button>
                  )}

                  <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                    updated {fmtTs(p.updatedAtMs)} · last used {fmtTs(p.lastUsedAtMs)}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* A/B comparison — read-only */}
      {profiles.length >= 2 ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <header className="mb-3 flex items-center gap-2">
            <ArrowLeftRight className="size-3.5 text-muted-foreground" aria-hidden />
            <h3 className="font-mono text-[10px] tracking-widest text-muted-foreground">PROFILE COMPARISON (READ-ONLY)</h3>
          </header>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label htmlFor="compare-a" className="font-mono text-[10px] text-muted-foreground">
              A:
            </label>
            <select
              id="compare-a"
              value={compareA}
              onChange={(e) => setCompareA(e.target.value)}
              className="h-8 rounded border border-border bg-background px-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Select profile…</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <label htmlFor="compare-b" className="font-mono text-[10px] text-muted-foreground">
              B:
            </label>
            <select
              id="compare-b"
              value={compareB}
              onChange={(e) => setCompareB(e.target.value)}
              className="h-8 rounded border border-border bg-background px-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Select profile…</option>
              {profiles
                .filter((p) => p.name !== compareA)
                .map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>

          {comparison.data ? <ComparisonTable result={comparison.data} /> : compareA && compareB ? (
            <p className="font-mono text-xs text-muted-foreground">computing…</p>
          ) : (
            <p className="font-mono text-xs text-muted-foreground">Select two profiles to compare their attributed trading history.</p>
          )}
        </div>
      ) : null}
    </section>
  )
}

function ComparisonTable({ result }: { result: import("@/lib/v2/engine/comparison").ComparisonResult }) {
  const { a, b, winners, recommendation } = result
  const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`
  const pf = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "∞")

  const rows: Array<{ key: string; label: string; va: string; vb: string }> = [
    { key: "totalTrades", label: "Trades", va: String(a.totalTrades), vb: String(b.totalTrades) },
    { key: "winRate", label: "Win rate", va: `${a.winRate.toFixed(1)}%`, vb: `${b.winRate.toFixed(1)}%` },
    { key: "netProfitUsd", label: "Net profit", va: usd(a.netProfitUsd), vb: usd(b.netProfitUsd) },
    { key: "roiPct", label: "ROI", va: a.roiPct !== null ? `${a.roiPct.toFixed(1)}%` : "—", vb: b.roiPct !== null ? `${b.roiPct.toFixed(1)}%` : "—" },
    { key: "profitFactor", label: "Profit factor", va: pf(a.profitFactor), vb: pf(b.profitFactor) },
    { key: "maxDrawdownPct", label: "Max drawdown", va: a.maxDrawdownPct !== null ? `${a.maxDrawdownPct.toFixed(1)}%` : "—", vb: b.maxDrawdownPct !== null ? `${b.maxDrawdownPct.toFixed(1)}%` : "—" },
    { key: "avgEntryPrice", label: "Avg entry", va: a.avgEntryPrice !== null ? `${(a.avgEntryPrice * 100).toFixed(1)}¢` : "—", vb: b.avgEntryPrice !== null ? `${(b.avgEntryPrice * 100).toFixed(1)}¢` : "—" },
    { key: "avgHoldingTimeSec", label: "Avg hold", va: a.avgHoldingTimeSec !== null ? `${a.avgHoldingTimeSec.toFixed(0)}s` : "—", vb: b.avgHoldingTimeSec !== null ? `${b.avgHoldingTimeSec.toFixed(0)}s` : "—" },
    { key: "largestWinUsd", label: "Largest win", va: usd(a.largestWinUsd), vb: usd(b.largestWinUsd) },
    { key: "largestLossUsd", label: "Largest loss", va: usd(a.largestLossUsd), vb: usd(b.largestLossUsd) },
    { key: "longestWinStreak", label: "Best streak", va: `${a.longestWinStreak}W`, vb: `${b.longestWinStreak}W` },
    { key: "longestLossStreak", label: "Worst streak", va: `${a.longestLossStreak}L`, vb: `${b.longestLossStreak}L` },
  ]

  const cellClass = (side: "a" | "b", key: string) =>
    winners[key] === side ? "text-neon" : winners[key] === "tie" || !(key in winners) ? "text-foreground" : "text-muted-foreground"

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-xs">
          <thead>
            <tr className="border-b border-border text-left text-[10px] tracking-widest text-muted-foreground">
              <th scope="col" className="py-1.5 pr-2 font-normal">
                METRIC
              </th>
              <th scope="col" className="py-1.5 pr-2 font-normal">
                {a.profileName.toUpperCase()} ({a.sessionCount} sessions)
              </th>
              <th scope="col" className="py-1.5 font-normal">
                {b.profileName.toUpperCase()} ({b.sessionCount} sessions)
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-border/50">
                <td className="py-1.5 pr-2 text-muted-foreground">{r.label}</td>
                <td className={`py-1.5 pr-2 tabular-nums ${cellClass("a", r.key)}`}>{r.va}</td>
                <td className={`py-1.5 tabular-nums ${cellClass("b", r.key)}`}>{r.vb}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 rounded border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        <Download className="mr-1.5 inline size-3 align-[-2px]" aria-hidden />
        {recommendation}
      </p>
    </div>
  )
}
