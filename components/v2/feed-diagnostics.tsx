"use client"

import { Activity } from "lucide-react"
import { useBotStatus } from "@/components/v2/use-bot"

/**
 * FEED DIAGNOSTICS — live market-data pipeline integrity panel.
 * Surfaces the atomic-snapshot validation state, feed generation,
 * WS/REST health, quote ages, and trigger eligibility so any feed
 * problem is diagnosable at a glance instead of guessed from logs.
 * Read-only: renders the same EngineSnapshot the dashboard polls.
 */
export function FeedDiagnostics() {
  const { data } = useBotStatus()
  if (!data) {
    return <div className="rounded-lg border border-border bg-card p-4 font-mono text-xs text-muted-foreground">reading feed state…</div>
  }

  const diag = data.clobDiagnostics
  const ws = diag?.ws
  const snap = data.feedSnapshotInfo
  const now = Date.now()

  const wsConnected = Boolean(ws?.connected)
  const wsMsgAge = ws && ws.lastMessageAtMs > 0 ? now - ws.lastMessageAtMs : null
  const restAge = diag && diag.lastRestUpdateMs > 0 ? now - diag.lastRestUpdateMs : null
  const genChangeAge = diag && diag.lastGenerationChangeMs > 0 ? now - diag.lastGenerationChangeMs : null
  const validationOk = snap !== null
  const confidence = snap?.confidence ?? null
  const rolling = data.rolloverState === "ROLLING_OVER"
  // Trigger eligibility mirrors the engine's execution gate exactly:
  // a validated snapshot with at least MEDIUM confidence, outside rollover.
  const triggerEligible = validationOk && confidence !== "LOW" && !rolling && data.running

  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-label="Feed diagnostics">
      <h3 className="mb-3 flex items-center gap-2 font-mono text-[10px] tracking-widest text-muted-foreground">
        <Activity className="size-3.5" aria-hidden />
        FEED DIAGNOSTICS
      </h3>

      {/* Headline states */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatusChip label="WS" ok={wsConnected} okText="CONNECTED" badText="DOWN" />
        <StatusChip label="REST" ok={restAge !== null && restAge < 60_000} okText={diag?.restCadence === "SLOW" ? "STANDBY" : "ACTIVE"} badText="STALE" />
        <StatusChip label="VALIDATION" ok={validationOk} okText="VALID" badText="INVALID" />
        <StatusChip
          label="TRIGGER"
          ok={triggerEligible}
          okText="ELIGIBLE"
          badText={rolling ? "ROLLOVER" : !data.running ? "STOPPED" : confidence === "LOW" ? "LOW CONF" : "BLOCKED"}
        />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-xs sm:grid-cols-4">
        <Row k="Generation" v={diag ? String(diag.generation) : "—"} />
        <Row k="Sequence" v={diag ? String(diag.sequence) : "—"} />
        <Row k="Snapshot age" v={snap ? fmtAge(now - snap.timestampMs) : "—"} vClass={snap ? undefined : "text-caution"} />
        <Row
          k="Confidence"
          v={confidence ?? "—"}
          vClass={confidence === "HIGH" ? "text-neon" : confidence === "MEDIUM" ? "text-caution" : confidence === "LOW" ? "text-crimson" : undefined}
        />
        <Row k="UP quote age" v={fmtAge(snap?.upAgeMs ?? diag?.upQuoteAgeMs ?? null)} />
        <Row k="DOWN quote age" v={fmtAge(snap?.downAgeMs ?? diag?.downQuoteAgeMs ?? null)} />
        <Row k="UP source" v={snap?.upSource ?? "—"} />
        <Row k="DOWN source" v={snap?.downSource ?? "—"} />
        <Row k="Last WS message" v={fmtAge(wsMsgAge)} vClass={wsMsgAge !== null && wsMsgAge > 30_000 ? "text-caution" : undefined} />
        <Row k="Last REST update" v={fmtAge(restAge)} />
        <Row k="REST cadence" v={diag?.restCadence ?? "—"} />
        <Row k="Last market change" v={fmtAge(genChangeAge)} />
        <Row k="WS ping RTT" v={ws?.pingRttMs !== null && ws?.pingRttMs !== undefined ? `${ws.pingRttMs}ms` : "—"} />
        <Row k="WS disconnects" v={ws ? String(ws.totalDisconnects) : "—"} />
        <Row k="API latency" v={diag?.apiLatencyMs !== null && diag?.apiLatencyMs !== undefined ? `${diag.apiLatencyMs}ms` : "—"} />
        <Row k="Engine state" v={rolling ? "ROLLING_OVER" : "LIVE"} vClass={rolling ? "text-caution" : "text-neon"} />
      </dl>

      {/* Failure reason surfaced only when validation is failing */}
      {!validationOk && diag?.validationFailReason ? (
        <p className="mt-3 rounded-md border border-caution/50 bg-caution/10 p-2 font-mono text-[10px] leading-relaxed text-caution">
          VALIDATION: {diag.validationFailReason}
        </p>
      ) : null}
      {diag?.emptyBook ? (
        <p className="mt-3 rounded-md border border-border bg-secondary/50 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
          EMPTY ASK BOOK — the market is listed but has no sell-side liquidity yet (normal for a freshly-opened candle; not a feed failure).
        </p>
      ) : null}
    </section>
  )
}

function StatusChip({ label, ok, okText, badText }: { label: string; ok: boolean; okText: string; badText: string }) {
  return (
    <div className={`rounded-md border p-2 text-center ${ok ? "border-neon/40 bg-neon/10" : "border-caution/40 bg-caution/10"}`}>
      <div className="font-mono text-[9px] tracking-widest text-muted-foreground">{label}</div>
      <div className={`font-mono text-[11px] font-semibold ${ok ? "text-neon" : "text-caution"}`}>{ok ? okText : badText}</div>
    </div>
  )
}

function Row({ k, v, vClass }: { k: string; v: string; vClass?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={`text-right tabular-nums ${vClass ?? "text-foreground"}`}>{v}</dd>
    </>
  )
}

function fmtAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—"
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}
