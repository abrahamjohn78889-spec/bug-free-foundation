"use client"

import { Fragment, useMemo, useState } from "react"
import { Search, ChevronDown, ChevronUp, Trash2 } from "lucide-react"
import type { EngineSnapshot, SettledTrade } from "@/lib/v2/engine/types"
import { useTrades, sendControl } from "./use-bot"
import { TradeReplayView } from "./trade-replay-view"

interface Props {
  snap: EngineSnapshot
  /** When false (tab hidden) the 2s trades poll is suspended entirely. */
  active?: boolean
}

/** Rows rendered per page — large ledgers paint instantly and grow on demand. */
const PAGE_SIZE = 100

type DatePreset = "all" | "today" | "yesterday" | "7d" | "30d" | "custom"
type SideFilter = "all" | "UP" | "DOWN"
type ResultFilter = "all" | "open" | "win" | "loss" | "scratch"

const startOfDay = (d: Date) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}

/** Parse the entry timestamp — prefers entryAtMs over the SQLite created_at string. */
function entryMs(t: SettledTrade): number {
  if (t.entryAtMs) return t.entryAtMs
  const raw = t.createdAt
  if (!raw) return t.slotEndMs || 0
  const ms = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z")
  return Number.isFinite(ms) ? ms : t.slotEndMs || 0
}

/** Parse the settlement timestamp from the SQLite settled_at string. */
function settledMs(t: SettledTrade): number | null {
  if (t.status !== "SETTLED") return null
  const raw = t.settledAt
  if (!raw) return null
  const ms = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z")
  return Number.isFinite(ms) ? ms : null
}

function fmt(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function fmtDate(ms: number) {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" })
}

/** Expanded detail row shown when the user clicks a trade row. */
/** Parse the persisted explanation JSON into ordered label/text rows. */
function parseExplanation(raw: string | null): Array<{ label: string; text: string }> {
  if (!raw) return []
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const labels: Record<string, string> = {
      entry: "WHY IT OPENED",
      sideSelection: "SIDE SELECTION",
      costCalc: "COST",
      settlement: "WHY IT SETTLED THIS WAY",
      pnlCalc: "PNL MATH",
      recovery: "RECOVERY",
    }
    const rows: Array<{ label: string; text: string }> = []
    for (const key of ["entry", "sideSelection", "costCalc", "settlement", "pnlCalc", "recovery"]) {
      const v = obj[key]
      if (typeof v === "string" && v) rows.push({ label: labels[key], text: v })
    }
    return rows
  } catch {
    return [{ label: "EXPLANATION", text: raw }]
  }
}

function TradeDetail({ t }: { t: SettledTrade }) {
  const settlementPrice = t.markPrice ?? (t.result === "WIN" ? 1 : t.result === "LOSS" ? 0 : null)
  const settledTime = settledMs(t)
  const explanationRows = parseExplanation(t.explanation)
  return (
    <tr className="bg-muted/20">
      <td colSpan={10} className="px-4 pb-3 pt-1">
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 font-mono text-[10px] text-muted-foreground sm:grid-cols-4">
          <div>
            <div className="tracking-widest">ORDER ID</div>
            <div className="truncate text-foreground">{t.orderId ?? "—"}</div>
          </div>
          <div>
            <div className="tracking-widest">TRADE UID</div>
            <div className="truncate text-foreground">{t.tradeUid ? t.tradeUid.slice(0, 16) + "…" : "—"}</div>
          </div>
          <div>
            <div className="tracking-widest">MARKET</div>
            <div className="truncate text-foreground">{t.marketId}</div>
          </div>
          <div>
            <div className="tracking-widest">SLOT END</div>
            <div className="text-foreground">{t.slotEndMs ? new Date(t.slotEndMs).toLocaleTimeString() : "—"}</div>
          </div>
          <div>
            <div className="tracking-widest">ENTRY TIME</div>
            <div className="text-foreground">{entryMs(t) ? `${fmtDate(entryMs(t))} ${fmt(entryMs(t))}` : "—"}</div>
          </div>
          <div>
            <div className="tracking-widest">SETTLEMENT TIME</div>
            <div className="text-foreground">{settledTime ? `${fmtDate(settledTime)} ${fmt(settledTime)}` : "—"}</div>
          </div>
          <div>
            <div className="tracking-widest">EXIT / SETTLE PRICE</div>
            <div className="text-foreground">{settlementPrice !== null ? `$${settlementPrice.toFixed(2)}` : "—"}</div>
          </div>
          <div>
            <div className="tracking-widest">TOTAL COST</div>
            <div className="text-foreground">${t.cost.toFixed(4)}</div>
          </div>
          <div>
            <div className="tracking-widest">FEES</div>
            {/* Polymarket charges zero maker fees on the CLOB; paper sim also zero */}
            <div className="text-foreground">$0.00</div>
          </div>
          <div>
            <div className="tracking-widest">DUST SAVED</div>
            <div className="text-foreground">${t.dustSaved.toFixed(4)}</div>
          </div>
          <div>
            <div className="tracking-widest">BALANCE AFTER</div>
            <div className="text-foreground">${t.balanceAfter.toFixed(2)}</div>
          </div>
          <div>
            <div className="tracking-widest">MODE</div>
            <div className="text-foreground">{t.mode}</div>
          </div>
        </div>
        {explanationRows.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-border/50 pt-2 font-mono text-[10px]">
            {explanationRows.map((row) => (
              <div key={row.label} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                <span className="shrink-0 tracking-widest text-muted-foreground sm:w-44">{row.label}</span>
                <span className="text-foreground">{row.text}</span>
              </div>
            ))}
          </div>
        )}
        {/* Forensic replay: full stored decision evidence + direction verdict. */}
        <TradeReplayView tradeId={t.id} />
      </td>
    </tr>
  )
}

export function Ledger({ snap, active = true }: Props) {
  const { data, mutate } = useTrades(active)
  const trades = useMemo<SettledTrade[]>(() => data?.trades ?? [], [data])
  const [resetting, setResetting] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  async function handleReset() {
    if (resetting) return
    const ok = window.confirm(
      "Reset the paper-trading ledger?\n\nThis permanently clears all trades, order history, and realized PnL for the current mode. This cannot be undone.",
    )
    if (!ok) return
    setResetting(true)
    try {
      await sendControl({ action: "reset_ledger" })
      await mutate()
    } finally {
      setResetting(false)
    }
  }

  const [datePreset, setDatePreset] = useState<DatePreset>("all")
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")
  const [sideFilter, setSideFilter] = useState<SideFilter>("all")
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all")
  const [query, setQuery] = useState("")
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const dateWindow = useMemo<{ from: number; to: number } | null>(() => {
    const now = new Date()
    const todayStart = startOfDay(now)
    const day = 24 * 60 * 60 * 1000
    switch (datePreset) {
      case "today":    return { from: todayStart, to: todayStart + day }
      case "yesterday":return { from: todayStart - day, to: todayStart }
      case "7d":       return { from: todayStart - 6 * day, to: todayStart + day }
      case "30d":      return { from: todayStart - 29 * day, to: todayStart + day }
      case "custom": {
        const from = customFrom ? startOfDay(new Date(customFrom)) : 0
        const to   = customTo   ? startOfDay(new Date(customTo)) + day : Number.MAX_SAFE_INTEGER
        return { from, to }
      }
      default: return null
    }
  }, [datePreset, customFrom, customTo])

  const displayTrades = useMemo(() => {
    const q = query.trim().toLowerCase()
    return trades.filter((t) => {
      if (dateWindow) {
        const ts = entryMs(t)
        if (ts < dateWindow.from || ts >= dateWindow.to) return false
      }
      if (sideFilter !== "all" && t.side !== sideFilter) return false
      // RESULT filter: "open" matches OPEN rows; win/loss/scratch match settled rows.
      if (resultFilter === "open"    && t.status !== "OPEN")    return false
      if (resultFilter === "win"     && t.result !== "WIN")     return false
      if (resultFilter === "loss"    && t.result !== "LOSS")    return false
      if (resultFilter === "scratch" && t.result !== "SCRATCH") return false
      if (q) {
        const hay = `${t.marketId} #${t.id} ${t.orderId ?? ""} ${t.tradeUid ?? ""}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [trades, dateWindow, sideFilter, resultFilter, query])

  // Render at most `visibleCount` rows — stats below are still computed over
  // the FULL filtered set, so the summary numbers never lie.
  const pagedTrades = useMemo(() => displayTrades.slice(0, visibleCount), [displayTrades, visibleCount])

  // Single memoized pass over the filtered set (was 4 separate iterations,
  // recomputed on every poll-driven render even when trades were unchanged).
  const { filteredPnl, filteredWins, filteredLosses, filteredOpen } = useMemo(() => {
    let pnl = 0
    let wins = 0
    let losses = 0
    let open = 0
    for (const t of displayTrades) {
      if (t.status === "SETTLED") pnl += t.pnl
      if (t.result === "WIN") wins++
      else if (t.result === "LOSS") losses++
      if (t.status === "OPEN") open++
    }
    return { filteredPnl: pnl, filteredWins: wins, filteredLosses: losses, filteredOpen: open }
  }, [displayTrades])

  const livePos = snap.standingLimitOrder?.openPosition ?? null

  const datePresets: { id: DatePreset; label: string }[] = [
    { id: "all",       label: "ALL" },
    { id: "today",     label: "TODAY" },
    { id: "yesterday", label: "YESTERDAY" },
    { id: "7d",        label: "LAST 7D" },
    { id: "30d",       label: "LAST 30D" },
    { id: "custom",    label: "CUSTOM" },
  ]

  const chip = (active: boolean) =>
    `rounded px-2 py-1 font-mono text-[10px] tracking-wide transition-colors border ${
      active
        ? "border-primary bg-primary/15 text-primary"
        : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground"
    }`

  return (
    <section aria-label="Compounding Ledger" className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-mono text-sm tracking-widest text-muted-foreground">[ D ] COMPOUNDING LEDGER</h2>
        <div className="flex flex-wrap gap-4 font-mono text-xs">
          <span className="text-muted-foreground">
            BANKROLL <span className="text-neon text-glow-neon">${(snap.balance + snap.dustReserve).toFixed(2)}</span>
          </span>
          <span className="text-muted-foreground">
            TOTAL PNL{" "}
            <span className={snap.totalPnl >= 0 ? "text-neon text-glow-neon" : "text-crimson"}>
              {snap.totalPnl >= 0 ? "+" : ""}${snap.totalPnl.toFixed(2)}
            </span>
          </span>
          <span className="text-muted-foreground">
            W / L <span className="text-foreground">{snap.wins} / {snap.losses}</span>
          </span>
          <button
            type="button"
            onClick={handleReset}
            disabled={resetting}
            title="Clear all paper trades, order history, and realized PnL for the current mode"
            className="flex items-center gap-1 rounded border border-crimson/40 bg-crimson/10 px-2 py-1 text-[10px] tracking-wide text-crimson transition-colors hover:bg-crimson/20 disabled:opacity-50"
          >
            <Trash2 className="size-3" aria-hidden />
            {resetting ? "RESETTING…" : "RESET"}
          </button>
        </div>
      </header>

      {/* Live standing-order execution card */}
      {livePos && (
        <div className="flex flex-col gap-2 rounded-md border border-neon/50 bg-neon/5 p-3 font-mono text-xs">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 tracking-widest text-neon text-glow-neon">
              <span className="inline-block size-2 animate-pulse rounded-full bg-neon" aria-hidden />
              LIVE OPEN POSITION
            </span>
            <span className="text-muted-foreground">filled {fmt(livePos.filledAtMs)}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <div className="text-muted-foreground">SIDE</div>
              <div className={livePos.side === "UP" ? "text-neon" : "text-crimson"}>{livePos.side}</div>
            </div>
            <div>
              <div className="text-muted-foreground">ENTRY</div>
              <div className="tabular-nums text-foreground">${livePos.entryPrice.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">MARK</div>
              <div className="tabular-nums text-foreground">
                {livePos.markPrice !== null ? `$${livePos.markPrice.toFixed(2)}` : <span className="text-caution">NO DATA</span>}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">SHARES</div>
              <div className="tabular-nums text-foreground">{livePos.shares}</div>
            </div>
            <div>
              <div className="text-muted-foreground">POS VALUE</div>
              <div className="tabular-nums text-foreground">
                {livePos.positionValue !== null ? `$${livePos.positionValue.toFixed(2)}` : <span className="text-caution">—</span>}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">UNREALIZED PNL</div>
              {livePos.unrealizedPnl !== null ? (
                <div className={`tabular-nums ${livePos.unrealizedPnl >= 0 ? "text-neon text-glow-neon" : "text-crimson text-glow-crimson"}`}>
                  {livePos.unrealizedPnl >= 0 ? "+" : ""}${livePos.unrealizedPnl.toFixed(2)}
                </div>
              ) : (
                <div className="tabular-nums text-caution" title="Live Polymarket mark unavailable — PnL pending">pending</div>
              )}
            </div>
          </div>
          <div className="truncate text-[10px] text-muted-foreground">market: {livePos.marketId}</div>
        </div>
      )}

      {/* Filters + search */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {datePresets.map((p) => (
            <button key={p.id} type="button" onClick={() => setDatePreset(p.id)} className={chip(datePreset === p.id)}>
              {p.label}
            </button>
          ))}
        </div>

        {datePreset === "custom" && (
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
            <label className="flex items-center gap-1">
              FROM
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded border border-border bg-secondary/40 px-2 py-1 text-foreground" />
            </label>
            <label className="flex items-center gap-1">
              TO
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                className="rounded border border-border bg-secondary/40 px-2 py-1 text-foreground" />
            </label>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] tracking-widest text-muted-foreground">SIDE</span>
          {(["all", "UP", "DOWN"] as SideFilter[]).map((s) => (
            <button key={s} type="button" onClick={() => setSideFilter(s)} className={chip(sideFilter === s)}>
              {s === "all" ? "ALL" : s}
            </button>
          ))}
          <span className="ml-2 font-mono text-[10px] tracking-widest text-muted-foreground">STATUS</span>
          {([
            { id: "all",     label: "ALL" },
            { id: "open",    label: "OPEN" },
            { id: "win",     label: "WIN" },
            { id: "loss",    label: "LOSS" },
            { id: "scratch", label: "SCRATCH" },
          ] as { id: ResultFilter; label: string }[]).map((r) => (
            <button key={r.id} type="button" onClick={() => setResultFilter(r.id)} className={chip(resultFilter === r.id)}>
              {r.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 rounded border border-border bg-secondary/40 px-2 py-1">
          <Search className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search market, trade ID, order ID…"
            aria-label="Search trades"
            className="w-full bg-transparent font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap gap-4 font-mono text-[10px] text-muted-foreground">
          <span>SHOWING <span className="text-foreground">{displayTrades.length}</span> / {trades.length}</span>
          {filteredOpen > 0 && (
            <span>OPEN <span className="animate-pulse text-caution">{filteredOpen}</span></span>
          )}
          <span>
            REALIZED PNL{" "}
            <span className={filteredPnl >= 0 ? "text-neon" : "text-crimson"}>
              {filteredPnl >= 0 ? "+" : ""}${filteredPnl.toFixed(2)}
            </span>
          </span>
          <span>W / L <span className="text-foreground">{filteredWins} / {filteredLosses}</span></span>
        </div>
      </div>

      {/* Trade table — vertical scroll capped so the sticky header keeps
          column labels visible while scanning long histories. */}
      <div className="max-h-[32rem] overflow-x-auto overflow-y-auto">
        <table className="w-full font-mono text-xs">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-left text-muted-foreground">
              <th scope="col" className="w-4 py-2 pr-1" aria-label="Expand" />
              <th scope="col" className="py-2 pr-3 font-normal">#</th>
              <th scope="col" className="py-2 pr-3 font-normal">ENTRY TIME</th>
              <th scope="col" className="py-2 pr-3 font-normal">SIDE</th>
              <th scope="col" className="py-2 pr-3 font-normal">ENTRY PRICE</th>
              <th scope="col" className="py-2 pr-3 font-normal">SHARES</th>
              <th scope="col" className="py-2 pr-3 font-normal">STATUS</th>
              <th scope="col" className="py-2 pr-3 font-normal">SETTLED</th>
              <th scope="col" className="py-2 pr-3 font-normal">BALANCE</th>
              <th scope="col" className="py-2 font-normal">REALIZED PNL</th>
            </tr>
          </thead>
          <tbody>
            {displayTrades.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-6 text-center text-muted-foreground">
                  {trades.length === 0
                    ? "No executions yet — arm a Standing Limit Order. Fills post here instantly."
                    : "No trades match the current filters."}
                </td>
              </tr>
            ) : null}
            {pagedTrades.map((t) => {
              const isOpen     = t.status === "OPEN"
              const isExpanded = expandedId === t.id
              const settledAt  = settledMs(t)
              const shownPnl   = isOpen ? null : t.pnl

              let statusCell: React.ReactNode
              if (isOpen) {
                statusCell = (
                  <span className="flex items-center gap-1 text-caution">
                    <span className="inline-block size-1.5 animate-pulse rounded-full bg-caution" aria-hidden />
                    OPEN
                  </span>
                )
              } else if (t.result === "WIN") {
                statusCell = <span className="text-neon">WIN</span>
              } else if (t.result === "LOSS") {
                statusCell = <span className="text-crimson">LOSS</span>
              } else {
                statusCell = <span className="text-muted-foreground">SCRATCH</span>
              }

              return (
                <Fragment key={t.id}>
                  <tr
                    className={`cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/30 ${isOpen ? "bg-caution/5" : ""}`}
                    onClick={() => setExpandedId(isExpanded ? null : t.id)}
                    aria-expanded={isExpanded}
                  >
                    <td className="py-2 pr-1 text-muted-foreground">
                      {isExpanded
                        ? <ChevronUp className="size-3" aria-hidden />
                        : <ChevronDown className="size-3" aria-hidden />}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">#{t.id}</td>
                    <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                      {fmtDate(entryMs(t))} {fmt(entryMs(t))}
                    </td>
                    <td className={`py-2 pr-3 font-semibold ${t.side === "UP" ? "text-neon" : "text-crimson"}`}>
                      {t.side}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-foreground">${t.price.toFixed(2)}</td>
                    <td className="py-2 pr-3 tabular-nums text-foreground">{t.shares}</td>
                    <td className="py-2 pr-3">{statusCell}</td>
                    <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                      {settledAt ? fmt(settledAt) : "—"}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-foreground">${t.balanceAfter.toFixed(2)}</td>
                    <td className={`py-2 tabular-nums ${
                      shownPnl === null
                        ? "text-muted-foreground"
                        : shownPnl >= 0
                          ? "text-neon text-glow-neon"
                          : "text-crimson text-glow-crimson"
                    }`}>
                      {shownPnl === null
                        ? <span className="text-[10px]">awaiting</span>
                        : `${shownPnl >= 0 ? "+" : ""}$${shownPnl.toFixed(2)}`}
                    </td>
                  </tr>
                  {isExpanded && <TradeDetail t={t} />}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        {displayTrades.length > visibleCount ? (
          <div className="flex justify-center border-t border-border/60 py-2">
            <button
              type="button"
              onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
              className="rounded-md border border-border bg-muted/10 px-4 py-1.5 font-mono text-[11px] tracking-widest text-muted-foreground transition-colors hover:text-foreground"
            >
              SHOW {Math.min(PAGE_SIZE, displayTrades.length - visibleCount)} MORE ({displayTrades.length - visibleCount}{" "}
              HIDDEN)
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
