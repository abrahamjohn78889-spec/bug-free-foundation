"use client"

import { AlertTriangle, Wallet } from "lucide-react"
import type { EngineSnapshot, LiveAccountData } from "@/lib/v2/engine/types"

interface Props {
  snap: EngineSnapshot
}

const money = (v: number | null, dp = 2) =>
  v === null || !Number.isFinite(v) ? null : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(dp)}`

const fmtTime = (ms: number) =>
  ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"

const shortAddr = (a: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—")

/** A labelled read-only stat. `pnl` colours the value by sign. */
function Stat({ label, value, pnl }: { label: string; value: string | null; pnl?: number | null }) {
  const cls =
    pnl === undefined || pnl === null
      ? "text-foreground"
      : pnl >= 0
        ? "text-neon text-glow-neon"
        : "text-crimson"
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] tracking-widest text-muted-foreground">{label}</span>
      {value === null ? (
        <span className="font-mono text-xs text-caution" title="Not available from the official API right now">
          N/A
        </span>
      ) : (
        <span className={`font-mono text-sm tabular-nums ${cls}`}>{value}</span>
      )}
    </div>
  )
}

export function LiveAccount({ snap }: Props) {
  // Read-only account mirror only applies to the LIVE_V2 pipeline.
  if (snap.mode !== "LIVE_V2") return null

  const acct: LiveAccountData | null = snap.liveAccount

  return (
    <section
      aria-label="Live Polymarket Account"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-mono text-sm tracking-widest text-muted-foreground">
          <Wallet className="size-4 text-crimson" aria-hidden />
          LIVE POLYMARKET ACCOUNT
        </h2>
        <span className="font-mono text-[10px] text-muted-foreground">
          {acct ? `SYNCED ${fmtTime(acct.fetchedAtMs)}` : "SYNCING…"}
        </span>
      </header>

      {!acct ? (
        <p className="font-mono text-xs text-muted-foreground">
          Waiting for the first account sync. Start the engine in LIVE_V2 to mirror your Polymarket account here.
        </p>
      ) : (
        <>
          {acct.errors.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 font-mono text-[10px] text-caution">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span>
                {acct.errors.length} data source{acct.errors.length > 1 ? "s" : ""} unavailable this cycle — affected
                fields show N/A instead of estimates.
              </span>
            </div>
          )}

          {/* Identity */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] tracking-widest text-muted-foreground">WALLET / DEPOSIT</span>
              <span className="font-mono text-sm text-foreground" title={acct.walletAddress ?? undefined}>
                {shortAddr(acct.walletAddress)}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] tracking-widest text-muted-foreground">USERNAME</span>
              <span
                className="font-mono text-xs text-caution"
                title="Polymarket exposes no official endpoint to resolve a username from a wallet address"
              >
                NOT AVAILABLE VIA API
              </span>
            </div>
          </div>

          {/* Balances + PnL */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label="AVAILABLE USDC" value={money(acct.availableUsd)} />
            <Stat label="PORTFOLIO VALUE" value={money(acct.portfolioValueUsd)} />
            <Stat
              label="UNREALIZED PNL"
              value={money(acct.totalUnrealizedPnl)}
              pnl={acct.totalUnrealizedPnl}
            />
            <Stat label="REALIZED PNL" value={money(acct.totalRealizedPnl)} pnl={acct.totalRealizedPnl} />
          </div>

          {/* Counts */}
          <div className="flex flex-wrap gap-4 font-mono text-[10px] text-muted-foreground">
            <span>
              OPEN ORDERS <span className="text-foreground">{acct.stats.openOrderCount}</span>
            </span>
            <span>
              POSITIONS <span className="text-foreground">{acct.stats.positionCount}</span>
            </span>
            <span>
              RECENT TRADES <span className="text-foreground">{acct.stats.recentTradeCount}</span>
            </span>
          </div>

          {/* Active positions */}
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] tracking-widest text-muted-foreground">ACTIVE POSITIONS</span>
            {acct.positions.length === 0 ? (
              <p className="font-mono text-[11px] text-muted-foreground">No open positions.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full font-mono text-[11px]">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th scope="col" className="py-1.5 pr-3 font-normal">MARKET</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">OUTCOME</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">SIZE</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">AVG</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">CUR</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">VALUE</th>
                      <th scope="col" className="py-1.5 font-normal">PNL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acct.positions.slice(0, 12).map((p) => (
                      <tr key={p.asset} className="border-b border-border/50">
                        <td className="max-w-[180px] truncate py-1.5 pr-3 text-foreground" title={p.title}>
                          {p.title || p.conditionId.slice(0, 10)}
                        </td>
                        <td className="py-1.5 pr-3 text-muted-foreground">{p.outcome}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-foreground">{p.size.toLocaleString()}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">${p.avgPrice.toFixed(2)}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">${p.curPrice.toFixed(2)}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-foreground">${p.currentValue.toFixed(2)}</td>
                        <td
                          className={`py-1.5 tabular-nums ${p.cashPnl >= 0 ? "text-neon" : "text-crimson"}`}
                        >
                          {p.cashPnl >= 0 ? "+" : ""}${p.cashPnl.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Open orders */}
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] tracking-widest text-muted-foreground">OPEN ORDERS</span>
            {acct.openOrders.length === 0 ? (
              <p className="font-mono text-[11px] text-muted-foreground">No resting orders on the book.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full font-mono text-[11px]">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th scope="col" className="py-1.5 pr-3 font-normal">OUTCOME</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">SIDE</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">PRICE</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">FILLED</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">SIZE</th>
                      <th scope="col" className="py-1.5 font-normal">TYPE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acct.openOrders.slice(0, 12).map((o) => (
                      <tr key={o.id} className="border-b border-border/50">
                        <td className="py-1.5 pr-3 text-muted-foreground">{o.outcome}</td>
                        <td className="py-1.5 pr-3 text-foreground">{o.side}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-foreground">${o.price.toFixed(2)}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{o.sizeMatched}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-foreground">{o.originalSize}</td>
                        <td className="py-1.5 text-muted-foreground">{o.orderType}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recent trades / fills / order history */}
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] tracking-widest text-muted-foreground">
              RECENT TRADES · FILLS · ORDER HISTORY
            </span>
            {acct.recentTrades.length === 0 ? (
              <p className="font-mono text-[11px] text-muted-foreground">No trades on record for this account.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full font-mono text-[11px]">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th scope="col" className="py-1.5 pr-3 font-normal">TIME</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">OUTCOME</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">SIDE</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">PRICE</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">SIZE</th>
                      <th scope="col" className="py-1.5 pr-3 font-normal">ROLE</th>
                      <th scope="col" className="py-1.5 font-normal">STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acct.recentTrades.slice(0, 15).map((t) => (
                      <tr key={t.id} className="border-b border-border/50">
                        <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{fmtTime(t.matchTimeMs)}</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">{t.outcome}</td>
                        <td className="py-1.5 pr-3 text-foreground">{t.side}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-foreground">${t.price.toFixed(2)}</td>
                        <td className="py-1.5 pr-3 tabular-nums text-foreground">{t.size}</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">{t.traderSide}</td>
                        <td className="py-1.5 text-muted-foreground">{t.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
