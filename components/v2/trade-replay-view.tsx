"use client"

import { useState } from "react"
import { FileSearch, Loader2 } from "lucide-react"
import { useTradeReplay } from "./use-bot"

/**
 * Forensic replay detail for one trade: trigger-time feed snapshot
 * (Phase 1 feedAudit), order-log decision timeline, sibling trades,
 * and the direction VERDICT — all from permanently stored evidence.
 * Evidence loads on demand when the user opens the replay.
 */
export function TradeReplayView({ tradeId }: { tradeId: number }) {
  const [open, setOpen] = useState(false)
  const { data, error, isLoading } = useTradeReplay(open ? tradeId : null)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex items-center gap-1.5 rounded border border-border bg-secondary/40 px-2 py-1 font-mono text-[10px] tracking-widest text-muted-foreground transition-colors hover:text-foreground"
      >
        <FileSearch className="size-3" aria-hidden />
        REPLAY DECISION EVIDENCE
      </button>
    )
  }

  if (isLoading) {
    return (
      <div className="mt-2 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden /> loading stored evidence…
      </div>
    )
  }
  if (error || !data?.ok) {
    return (
      <div className="mt-2 font-mono text-[10px] text-crimson">
        replay unavailable: {error instanceof Error ? error.message : "trade not found"}
      </div>
    )
  }

  const { feedAudit, orderLog, siblingTrades, verdict } = data.replay
  const verdictColor =
    verdict.conclusion === "CORRECT" ? "text-neon" : verdict.conclusion === "WRONG_SIDE" ? "text-crimson" : "text-caution"

  return (
    <div className="mt-2 flex flex-col gap-2 rounded border border-border/70 bg-secondary/20 p-2 font-mono text-[10px]">
      <div className="flex items-center justify-between">
        <span className="tracking-widest text-muted-foreground">FORENSIC REPLAY — TRADE #{tradeId}</span>
        <span className={`tracking-widest ${verdictColor}`}>VERDICT: {verdict.conclusion.replace("_", " ")}</span>
      </div>

      {/* Trigger-time snapshot (Phase 1 evidence) */}
      <div>
        <div className="tracking-widest text-muted-foreground">TRIGGER-TIME FEED SNAPSHOT</div>
        {feedAudit?.quotes ? (
          <div className="mt-0.5 grid grid-cols-2 gap-x-6 gap-y-0.5 text-foreground sm:grid-cols-4">
            <span>
              UP ${feedAudit.quotes.up.price.toFixed(4)}{" "}
              <span className="text-muted-foreground">[{feedAudit.quotes.up.source} {feedAudit.quotes.up.ageMs}ms]</span>
            </span>
            <span>
              DOWN ${feedAudit.quotes.down.price.toFixed(4)}{" "}
              <span className="text-muted-foreground">[{feedAudit.quotes.down.source} {feedAudit.quotes.down.ageMs}ms]</span>
            </span>
            <span>
              TRIGGER ${feedAudit.triggerPrice?.toFixed(2) ?? "?"}{" "}
              <span className="text-muted-foreground">[{feedAudit.triggerMode ?? "?"}]</span>
            </span>
            <span>
              GEN {feedAudit.generation ?? "?"} <span className="text-muted-foreground">conf {feedAudit.confidence ?? "?"}</span>
            </span>
            {feedAudit.majority && (
              <span className="col-span-2">
                MAJORITY {feedAudit.majority.side}{" "}
                <span className="text-muted-foreground">
                  (UP {feedAudit.majority.upPct ?? "?"}% / DOWN {feedAudit.majority.downPct ?? "?"}%)
                </span>
              </span>
            )}
          </div>
        ) : (
          <div className="mt-0.5 text-caution">
            Not available — this trade predates the permanent trigger-snapshot audit (Phase 1). Verdict is derived from
            the remaining evidence below.
          </div>
        )}
      </div>

      {/* Decision timeline */}
      <div>
        <div className="tracking-widest text-muted-foreground">DECISION TIMELINE ({orderLog.length} events)</div>
        <div className="mt-0.5 max-h-40 overflow-y-auto">
          {orderLog.length === 0 ? (
            <div className="text-muted-foreground">no order-log rows (possibly pruned by retention)</div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {orderLog.map((r) => (
                <li key={r.id} className="text-foreground">
                  <span className="text-muted-foreground">{new Date(r.ts_ms).toLocaleTimeString()}</span> {r.event}{" "}
                  {r.side ?? ""} {r.price !== null ? `$${r.price.toFixed(4)}` : ""}
                  {r.detail ? <span className="text-muted-foreground"> — {r.detail}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Siblings */}
      {siblingTrades.length > 0 && (
        <div>
          <div className="tracking-widest text-muted-foreground">SAME-SLOT TRADES</div>
          <ul className="mt-0.5 flex flex-col gap-0.5 text-foreground">
            {siblingTrades.map((s) => (
              <li key={s.id}>
                #{s.id}: {s.side} @ ${s.price.toFixed(4)} × {s.shares} — {s.result}, PnL ${s.pnl.toFixed(2)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Verdict reasoning */}
      <div>
        <div className="tracking-widest text-muted-foreground">FINDINGS</div>
        <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-4 text-foreground">
          {verdict.findings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
        {verdict.missingEvidence.length > 0 && (
          <div className="mt-1">
            <span className="tracking-widest text-caution">MISSING EVIDENCE</span>
            <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-4 text-muted-foreground">
              {verdict.missingEvidence.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
