"use client"
import { useEffect, useState } from "react"
import useSWR from "swr"
import type { LatencyReport, LatencySampleRow } from "@/lib/v2/engine/db"

type ApiResponse = { report: LatencyReport; samples: LatencySampleRow[] }
const fetcher = (u: string) => fetch(u).then((r) => r.json() as Promise<ApiResponse>)

const PHASE_ROWS: Array<{ key: keyof LatencyReport["phases"]; label: string }> = [
  { key: "quoteAge", label: "quote age (freshness)" },
  { key: "decision", label: "snapshot → decision" },
  { key: "preSubmit", label: "decision → placeOrder" },
  { key: "submit", label: "submit → ack (publish)" },
  { key: "fillCheck", label: "ack → immediate fill-check" },
  { key: "total", label: "snapshot → ack (total)" },
  { key: "fillObserved", label: "publish → observed fill" },
]

export default function LatencyReportPage() {
  const [mode, setMode] = useState<"PAPER_V1" | "LIVE_V2">("LIVE_V2")
  const [windowMin, setWindowMin] = useState<number>(1440)
  const { data, isLoading, error, mutate } = useSWR<ApiResponse>(
    `/api/v2/bot/latency?mode=${mode}&window=${windowMin}&limit=100`,
    fetcher,
    { refreshInterval: 15_000 },
  )
  useEffect(() => { mutate() }, [mode, windowMin, mutate])

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 24px", fontFamily: "var(--font-geist-sans, ui-sans-serif)" }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: -0.2, margin: 0 }}>Execution latency report</h1>
          <p style={{ color: "#8a8f98", fontSize: 13, margin: "4px 0 0" }}>
            Publish → ack → observed fill percentiles. Persisted per submission; survives restarts.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={mode} onChange={(e) => setMode(e.target.value as "PAPER_V1" | "LIVE_V2")}
                  style={{ background: "#111318", color: "#e6e7ea", border: "1px solid #2a2d33", borderRadius: 6, padding: "6px 10px", fontSize: 13 }}>
            <option value="LIVE_V2">LIVE_V2</option>
            <option value="PAPER_V1">PAPER_V1</option>
          </select>
          <select value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))}
                  style={{ background: "#111318", color: "#e6e7ea", border: "1px solid #2a2d33", borderRadius: 6, padding: "6px 10px", fontSize: 13 }}>
            <option value={60}>last 1h</option>
            <option value={360}>last 6h</option>
            <option value={1440}>last 24h</option>
            <option value={10080}>last 7d</option>
            <option value={43200}>last 30d</option>
          </select>
        </div>
      </header>

      {error && <p style={{ color: "#ff6b6b" }}>Failed to load metrics.</p>}
      {isLoading && !data && <p style={{ color: "#8a8f98" }}>Loading…</p>}

      {data && (
        <>
          <section style={{ background: "#0e1015", border: "1px solid #1c1f25", borderRadius: 10, padding: 16, marginBottom: 24 }}>
            <div style={{ display: "flex", gap: 24, marginBottom: 12, fontSize: 12, color: "#8a8f98" }}>
              <span>samples: <strong style={{ color: "#e6e7ea" }}>{data.report.sampleCount}</strong></span>
              <span>filled: <strong style={{ color: "#e6e7ea" }}>{data.report.filledCount}</strong></span>
              <span>window: <strong style={{ color: "#e6e7ea" }}>{(data.report.windowMs / 3_600_000).toFixed(1)}h</strong></span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-geist-mono, ui-monospace)" }}>
              <thead>
                <tr style={{ textAlign: "right", color: "#8a8f98", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  <th style={{ textAlign: "left", padding: "8px 6px" }}>phase</th>
                  <th style={{ padding: "8px 6px" }}>n</th>
                  <th style={{ padding: "8px 6px" }}>avg</th>
                  <th style={{ padding: "8px 6px" }}>p50</th>
                  <th style={{ padding: "8px 6px" }}>p95</th>
                  <th style={{ padding: "8px 6px" }}>max</th>
                </tr>
              </thead>
              <tbody>
                {PHASE_ROWS.map(({ key, label }) => {
                  const s = data.report.phases[key]
                  return (
                    <tr key={key} style={{ borderTop: "1px solid #1c1f25", fontSize: 13 }}>
                      <td style={{ padding: "8px 6px", color: "#c8ccd3" }}>{label}</td>
                      <td style={{ padding: "8px 6px", textAlign: "right", color: "#8a8f98" }}>{s.count}</td>
                      <td style={{ padding: "8px 6px", textAlign: "right" }}>{s.avg}ms</td>
                      <td style={{ padding: "8px 6px", textAlign: "right" }}>{s.p50}ms</td>
                      <td style={{ padding: "8px 6px", textAlign: "right" }}>{s.p95}ms</td>
                      <td style={{ padding: "8px 6px", textAlign: "right", color: s.max > 500 ? "#ff8383" : "#e6e7ea" }}>{s.max}ms</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>

          <section>
            <h2 style={{ fontSize: 14, color: "#8a8f98", fontWeight: 500, margin: "0 0 8px" }}>Recent submissions</h2>
            <div style={{ maxHeight: 480, overflow: "auto", border: "1px solid #1c1f25", borderRadius: 10 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-geist-mono, ui-monospace)" }}>
                <thead style={{ position: "sticky", top: 0, background: "#0e1015" }}>
                  <tr style={{ color: "#8a8f98", textTransform: "uppercase", letterSpacing: 0.5, fontSize: 10 }}>
                    <th style={{ padding: "8px 6px", textAlign: "left" }}>ts</th>
                    <th style={{ padding: "8px 6px", textAlign: "left" }}>side</th>
                    <th style={{ padding: "8px 6px", textAlign: "right" }}>qty</th>
                    <th style={{ padding: "8px 6px", textAlign: "right" }}>limit</th>
                    <th style={{ padding: "8px 6px", textAlign: "right" }}>quote</th>
                    <th style={{ padding: "8px 6px", textAlign: "right" }}>submit</th>
                    <th style={{ padding: "8px 6px", textAlign: "right" }}>total</th>
                    <th style={{ padding: "8px 6px", textAlign: "right" }}>fill</th>
                  </tr>
                </thead>
                <tbody>
                  {data.samples.map((s) => (
                    <tr key={s.id} style={{ borderTop: "1px solid #1c1f25" }}>
                      <td style={{ padding: "6px", color: "#8a8f98" }}>{new Date(s.ts_ms).toISOString().slice(11, 19)}</td>
                      <td style={{ padding: "6px" }}>{s.side ?? "—"}</td>
                      <td style={{ padding: "6px", textAlign: "right" }}>{s.shares ?? "—"}</td>
                      <td style={{ padding: "6px", textAlign: "right" }}>{s.limit_price != null ? `$${s.limit_price.toFixed(2)}` : "—"}</td>
                      <td style={{ padding: "6px", textAlign: "right" }}>{s.quote_age_ms}ms</td>
                      <td style={{ padding: "6px", textAlign: "right" }}>{s.submit_ms}ms</td>
                      <td style={{ padding: "6px", textAlign: "right" }}>{s.total_ms}ms</td>
                      <td style={{ padding: "6px", textAlign: "right", color: s.fill_observed_ms == null ? "#8a8f98" : "#e6e7ea" }}>
                        {s.fill_observed_ms == null ? "—" : `${s.fill_observed_ms}ms`}
                      </td>
                    </tr>
                  ))}
                  {data.samples.length === 0 && (
                    <tr><td colSpan={8} style={{ padding: 16, textAlign: "center", color: "#8a8f98" }}>No samples yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  )
}
