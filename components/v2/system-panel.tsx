"use client"

import { useState } from "react"
import { Download, HardDrive, RefreshCw, ShieldCheck } from "lucide-react"
import { useAuditLog, useDbStats, useNotifyPrefs, useSystemInfo } from "@/components/v2/use-bot"
import { FeedDiagnostics } from "@/components/v2/feed-diagnostics"

/**
 * SYSTEM — VPS + process monitoring, database tools, notification
 * category toggles, and the filterable audit log. All read-only or
 * operator-tools; nothing here can affect trading.
 */
export function SystemPanel({ active }: { active: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <FeedDiagnostics />
      <div className="grid gap-4 lg:grid-cols-2">
        <SystemMonitor active={active} />
        <NotificationSettings active={active} />
      </div>
      <DatabaseTools active={active} />
      <AuditLog active={active} />
    </div>
  )
}

// ---------- system monitor ----------

function SystemMonitor({ active }: { active: boolean }) {
  const { data } = useSystemInfo(active)
  if (!data) {
    return <div className="rounded-lg border border-border bg-card p-4 font-mono text-xs text-muted-foreground">reading system state…</div>
  }
  const num = (v: unknown) => (typeof v === "number" ? v : 0)
  const cpu = (data.cpu ?? {}) as Record<string, unknown>
  const memory = (data.memory ?? {}) as Record<string, unknown>
  const disk = (data.disk ?? null) as Record<string, unknown> | null
  const uptime = (data.uptime ?? {}) as Record<string, unknown>
  const git = (data.git ?? {}) as Record<string, unknown>
  const engine = (data.engine ?? {}) as Record<string, unknown>

  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-label="System monitoring">
      <h3 className="mb-3 flex items-center gap-2 font-mono text-[10px] tracking-widest text-muted-foreground">
        <HardDrive className="size-3.5" aria-hidden />
        SYSTEM MONITOR
      </h3>
      <div className="flex flex-col gap-3">
        <Meter
          label="MEMORY"
          pct={num(memory.usedPct)}
          detail={`${(num(memory.processRssBytes) / 1048576).toFixed(0)} MB proc / ${(num(memory.totalBytes) / 1073741824).toFixed(1)} GB total`}
        />
        <Meter label="CPU" pct={num(cpu.usagePct)} detail={`load5 ${num(cpu.load5).toFixed(2)} · ${num(cpu.cores)} core(s)`} />
        {disk ? (
          <Meter label="DISK" pct={num(disk.usedPct)} detail={`${(num(disk.freeBytes) / 1073741824).toFixed(1)} GB free`} />
        ) : null}
        <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-xs">
          <Row k="Host uptime" v={fmtDur(num(uptime.osSec))} />
          <Row k="Process uptime" v={fmtDur(num(uptime.processSec))} />
          <Row k="Node" v={String(data.node ?? "—")} />
          <Row k="Engine" v={String(data.engineVersion ?? "—")} />
          <Row k="Git" v={git.commit ? `${String(git.branch ?? "?")}@${String(git.commit)}` : "—"} />
          <Row k="VPS time" v={typeof data.vpsTimeIso === "string" ? data.vpsTimeIso.slice(11, 19) + " UTC" : "—"} />
          <Row k="Clock offset" v={`${num(engine.clockOffsetMs).toFixed(0)}ms`} vClass={Math.abs(num(engine.clockOffsetMs)) > 500 ? "text-caution" : "text-neon"} />
          <Row k="Pipeline" v={`${String(engine.mode ?? "—")} ${engine.running ? "RUNNING" : "STOPPED"}`} vClass={engine.running ? "text-neon" : undefined} />
        </dl>
      </div>
    </section>
  )
}

function Meter({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  const clamped = Math.min(Math.max(pct, 0), 100)
  const toneClass = clamped > 90 ? "bg-crimson" : clamped > 75 ? "bg-caution" : "bg-neon"
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between font-mono text-[10px]">
        <span className="tracking-widest text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{clamped.toFixed(0)}% · {detail}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`h-full rounded-full ${toneClass}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  )
}

// ---------- notification settings ----------

const CATEGORY_LABELS: Record<string, string> = {
  lifecycle: "Bot started / stopped / restarts",
  market: "New market detected (every 5 min)",
  orders: "Orders: armed, triggered, filled",
  trades: "Trades: win / loss / scratch",
  summaries: "Daily + weekly summaries",
  risk: "Risk: kill switch, limits",
  recovery: "Recovery: watchdog, reconnects",
  system: "System: memory, CPU, database",
  errors: "Critical errors",
}

function NotificationSettings({ active }: { active: boolean }) {
  const { data, mutate } = useNotifyPrefs(active)
  const [busy, setBusy] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState("")

  async function toggle(cat: string, value: boolean) {
    setBusy(cat)
    try {
      await fetch("/api/v2/bot/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefs: { [cat]: value } }),
      })
      await mutate()
    } finally {
      setBusy(null)
    }
  }

  async function sendTest() {
    setBusy("test")
    setTestMsg("")
    try {
      const r = await fetch("/api/v2/bot/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      })
      setTestMsg(r.ok ? "Test sent — check Telegram" : "Test failed")
    } catch {
      setTestMsg("Test failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-label="Notification settings">
      <h3 className="mb-3 font-mono text-[10px] tracking-widest text-muted-foreground">TELEGRAM NOTIFICATIONS</h3>
      {!data ? (
        <p className="font-mono text-xs text-muted-foreground">loading preferences…</p>
      ) : (
        <>
          {!data.configured && (
            <p className="mb-3 rounded-md border border-caution/50 bg-caution/10 p-2 font-mono text-[10px] leading-relaxed text-caution">
              TELEGRAM NOT CONFIGURED — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env. Toggles still save.
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            {data.categories.map((cat) => (
              <label key={cat} className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 font-mono text-xs hover:bg-secondary/50">
                <span className="text-foreground">{CATEGORY_LABELS[cat] ?? cat}</span>
                <input
                  type="checkbox"
                  checked={Boolean(data.prefs[cat])}
                  disabled={busy === cat}
                  onChange={(e) => void toggle(cat, e.target.checked)}
                  className="size-4 accent-[var(--neon)]"
                  aria-label={`Toggle ${cat} notifications`}
                />
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void sendTest()}
              disabled={busy === "test" || !data.configured}
              className="rounded-md border border-border bg-secondary px-3 py-1.5 font-mono text-[10px] tracking-widest text-foreground hover:bg-secondary/70 disabled:opacity-50"
            >
              SEND TEST
            </button>
            {testMsg ? <span className="font-mono text-[10px] text-muted-foreground">{testMsg}</span> : null}
          </div>
        </>
      )}
    </section>
  )
}

// ---------- database tools ----------

function DatabaseTools({ active }: { active: boolean }) {
  const { data, mutate } = useDbStats(active)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState("")

  async function runAction(action: "backup" | "integrity") {
    setBusy(action)
    setResult("")
    try {
      const r = await fetch("/api/v2/bot/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const body = (await r.json()) as { ok?: boolean; file?: string; result?: string }
      if (action === "backup") setResult(body.ok ? `Backup created: ${body.file}` : "Backup failed")
      else setResult(`Integrity: ${body.result ?? "unknown"}`)
      await mutate()
    } catch {
      setResult(`${action} failed`)
    } finally {
      setBusy(null)
    }
  }

  const mb = (b: number) => (b / 1048576).toFixed(2)

  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-label="Database tools">
      <h3 className="mb-3 flex items-center gap-2 font-mono text-[10px] tracking-widest text-muted-foreground">
        <ShieldCheck className="size-3.5" aria-hidden />
        DATABASE
      </h3>
      {!data ? (
        <p className="font-mono text-xs text-muted-foreground">reading database stats…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-xs sm:grid-cols-4">
            <Row k="DB size" v={`${mb(data.fileSizeBytes)} MB`} />
            <Row k="WAL size" v={`${mb(data.walSizeBytes)} MB`} />
            <Row k="Trades" v={String(data.tradeCount)} />
            <Row k="Order log" v={String(data.orderLogCount)} />
            <Row k="Audit log" v={String(data.auditLogCount)} />
            <Row k="Backups" v={String(data.backups.length)} />
            <Row k="Last backup" v={data.lastBackupAt ? new Date(data.lastBackupAt).toISOString().slice(0, 16).replace("T", " ") : "never"} vClass={data.lastBackupAt ? undefined : "text-caution"} />
            <Row k="Integrity" v={data.integrityOk === null ? "not checked" : data.integrityOk ? "OK" : "FAILED"} vClass={data.integrityOk === false ? "text-crimson" : data.integrityOk ? "text-neon" : undefined} />
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <ToolButton onClick={() => void runAction("backup")} disabled={busy !== null} label={busy === "backup" ? "BACKING UP…" : "BACKUP NOW"} />
            <ToolButton onClick={() => void runAction("integrity")} disabled={busy !== null} label={busy === "integrity" ? "CHECKING…" : "INTEGRITY CHECK"} />
            <a
              href="/api/v2/bot/database?export=csv"
              download
              className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 font-mono text-[10px] tracking-widest text-foreground hover:bg-secondary/70"
            >
              <Download className="size-3" aria-hidden />
              EXPORT CSV
            </a>
            <a
              href="/api/v2/bot/database?export=json"
              download
              className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 font-mono text-[10px] tracking-widest text-foreground hover:bg-secondary/70"
            >
              <Download className="size-3" aria-hidden />
              EXPORT JSON
            </a>
            {result ? <span className="font-mono text-[10px] text-muted-foreground">{result}</span> : null}
          </div>
          {data.backups.length > 0 && (
            <div className="font-mono text-[10px] text-muted-foreground">
              Recent backups: {data.backups.slice(0, 3).map((b) => b.name).join(", ")}
              {data.backups.length > 3 ? ` +${data.backups.length - 3} more` : ""}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function ToolButton({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-border bg-secondary px-3 py-1.5 font-mono text-[10px] tracking-widest text-foreground hover:bg-secondary/70 disabled:opacity-50"
    >
      {label}
    </button>
  )
}

// ---------- audit log ----------

const SINCE_CHOICES = [
  { label: "1H", ms: 3_600_000 },
  { label: "24H", ms: 86_400_000 },
  { label: "7D", ms: 7 * 86_400_000 },
  { label: "ALL", ms: 0 },
] as const

function AuditLog({ active }: { active: boolean }) {
  const [category, setCategory] = useState("")
  const [level, setLevel] = useState("")
  const [search, setSearch] = useState("")
  const [applied, setApplied] = useState("")
  const [sinceMs, setSinceMs] = useState<number>(86_400_000)

  const { data } = useAuditLog(active, {
    category: category || undefined,
    level: level || undefined,
    search: applied || undefined,
    since: sinceMs || undefined,
  })

  const downloadHref = (() => {
    const qs = new URLSearchParams({ download: "1", limit: "2000" })
    if (category) qs.set("category", category)
    if (level) qs.set("level", level)
    if (applied) qs.set("search", applied)
    if (sinceMs) qs.set("since", String(sinceMs))
    return `/api/v2/bot/audit?${qs.toString()}`
  })()

  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-label="Audit log">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-mono text-[10px] tracking-widest text-muted-foreground">AUDIT LOG</h3>
        <a
          href={downloadHref}
          download
          className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 font-mono text-[10px] tracking-widest text-foreground hover:bg-secondary/70"
        >
          <Download className="size-3" aria-hidden />
          DOWNLOAD
        </a>
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-md border border-border bg-secondary px-2 py-1.5 font-mono text-[10px] text-foreground"
          aria-label="Filter by category"
        >
          <option value="">ALL CATEGORIES</option>
          {(data?.categories ?? []).map((c) => (
            <option key={c} value={c}>{c.toUpperCase()}</option>
          ))}
        </select>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="rounded-md border border-border bg-secondary px-2 py-1.5 font-mono text-[10px] text-foreground"
          aria-label="Filter by level"
        >
          <option value="">ALL LEVELS</option>
          <option value="info">INFO</option>
          <option value="warn">WARN</option>
          <option value="error">ERROR</option>
        </select>
        <div className="flex gap-1" role="radiogroup" aria-label="Time range">
          {SINCE_CHOICES.map((c) => (
            <button
              key={c.label}
              type="button"
              role="radio"
              aria-checked={sinceMs === c.ms}
              onClick={() => setSinceMs(c.ms)}
              className={`rounded-md px-2 py-1.5 font-mono text-[10px] tracking-widest ${
                sinceMs === c.ms ? "bg-crimson/10 text-crimson" : "border border-border bg-secondary text-muted-foreground hover:text-foreground"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <form
          className="flex min-w-0 flex-1 items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            setApplied(search.trim())
          }}
        >
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search messages…"
            className="min-w-0 flex-1 rounded-md border border-border bg-secondary px-2 py-1.5 font-mono text-[10px] text-foreground placeholder:text-muted-foreground"
            aria-label="Search audit log"
          />
          <button type="submit" className="rounded-md border border-border bg-secondary p-1.5 text-muted-foreground hover:text-foreground" aria-label="Apply search">
            <RefreshCw className="size-3" aria-hidden />
          </button>
        </form>
      </div>

      {/* Rows */}
      <div className="max-h-80 overflow-y-auto rounded-md border border-border bg-background/50">
        {!data ? (
          <p className="p-3 font-mono text-xs text-muted-foreground">loading audit log…</p>
        ) : data.rows.length === 0 ? (
          <p className="p-3 font-mono text-xs text-muted-foreground">no entries match the current filters</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.rows.map((r) => (
              <li key={r.id} className="flex items-start gap-2 px-3 py-1.5 font-mono text-[10px] leading-relaxed">
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {new Date(r.tsMs).toISOString().slice(5, 19).replace("T", " ")}
                </span>
                <span className={`shrink-0 font-semibold ${r.level === "error" ? "text-crimson" : r.level === "warn" ? "text-caution" : "text-neon"}`}>
                  {r.level.toUpperCase()}
                </span>
                <span className="shrink-0 text-muted-foreground">[{r.category}]</span>
                <span className="min-w-0 break-words text-foreground">{r.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

// ---------- shared ----------

function Row({ k, v, vClass }: { k: string; v: string; vClass?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={`text-right tabular-nums ${vClass ?? "text-foreground"}`}>{v}</dd>
    </>
  )
}

function fmtDur(sec: number): string {
  if (sec <= 0) return "—"
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}
