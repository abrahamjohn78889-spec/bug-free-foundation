import os from "node:os"
import { env } from "./config"
import { kvGet, kvSet, exportTrades } from "./db"
import { onEvent, logEvent } from "./events"

// ------------------------------------------------------------
// Telegram OPERATIONS notifier — one-way, category-gated push
// notifications. Distinct from the interactive control bot in
// telegram.ts (which handles commands); this module only sends.
// No secrets ever appear in any message. Best-effort delivery:
// a Telegram outage can never affect trading.
// ------------------------------------------------------------

/** Notification categories, individually toggleable from the dashboard. */
export const NOTIFY_CATEGORIES = [
  "lifecycle",     // bot/engine started/stopped, PM2/VPS restart
  "market",        // new market detected
  "orders",        // armed, triggered, submitted, accepted, fills
  "trades",        // WIN / LOSS / SCRATCH settlements
  "summaries",     // daily + weekly summaries
  "risk",          // kill switch, risk limits
  "recovery",      // watchdog recovery, WS reconnect, REST failure, reconciler
  "system",        // database / memory / CPU warnings
  "errors",        // critical errors
] as const
export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number]

const PREFS_KEY = "notify:prefs:v1"

export type NotifyPrefs = Record<NotifyCategory, boolean>

const DEFAULT_PREFS: NotifyPrefs = {
  lifecycle: true,
  market: false,   // one per 5 minutes — noisy, off by default
  orders: true,
  trades: true,
  summaries: true,
  risk: true,
  recovery: true,
  system: true,
  errors: true,
}

export function getNotifyPrefs(): NotifyPrefs {
  try {
    const raw = kvGet(PREFS_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const parsed = JSON.parse(raw) as Partial<NotifyPrefs>
    return { ...DEFAULT_PREFS, ...parsed }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function setNotifyPrefs(update: Partial<NotifyPrefs>): NotifyPrefs {
  const next = { ...getNotifyPrefs() }
  for (const key of NOTIFY_CATEGORIES) {
    if (typeof update[key] === "boolean") next[key] = update[key]
  }
  kvSet(PREFS_KEY, JSON.stringify(next))
  logEvent("info", `Notification preferences updated: ${NOTIFY_CATEGORIES.filter((c) => next[c]).join(", ") || "all off"}`, "config")
  return next
}

// ---------- send machinery ----------

function telegramConfigured(): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
}

/** Per-category cooldown so a flapping condition cannot flood the chat. */
const COOLDOWN_MS: Record<NotifyCategory, number> = {
  lifecycle: 0,
  market: 0,
  orders: 0,
  trades: 0,
  summaries: 0,
  risk: 30_000,
  recovery: 60_000,
  system: 300_000,
  errors: 60_000,
}
const lastSentMs = new Map<string, number>()

/** Strip anything that looks like a secret before it can leave the process. */
function redact(text: string): string {
  return text
    .replace(/0x[a-fA-F0-9]{40,}/g, "[redacted-key]")
    .replace(/(token|secret|password|passphrase|apikey|api_key)=\S+/gi, "$1=[redacted]")
}

/**
 * Send a category-gated notification. Fire-and-forget: never throws, never
 * blocks, never retries into the trading path.
 */
export function notify(category: NotifyCategory, title: string, body?: string) {
  try {
    if (!telegramConfigured()) return
    if (!getNotifyPrefs()[category]) return
    const cooldown = COOLDOWN_MS[category]
    if (cooldown > 0) {
      const key = `${category}:${title}`
      const last = lastSentMs.get(key) ?? 0
      if (Date.now() - last < cooldown) return
      lastSentMs.set(key, Date.now())
    }
    const text = redact(body ? `<b>${title}</b>\n${body}` : `<b>${title}</b>`)
    void fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { /* best-effort */ })
  } catch {
    /* notification failures must never surface to callers */
  }
}

// ---------- summaries ----------

function summarize(sinceMs: number, label: string): string {
  const rows = exportTrades((kvGet("engine:mode") as "PAPER_V1" | "LIVE_V2" | null) ?? "PAPER_V1")
    .filter((r) => {
      const settled = Date.parse(`${String(r.settled_at)}Z`)
      return r.status === "SETTLED" && Number.isFinite(settled) && settled >= sinceMs
    })
  const wins = rows.filter((r) => r.result === "WIN").length
  const losses = rows.filter((r) => r.result === "LOSS").length
  const scratches = rows.filter((r) => r.result === "SCRATCH").length
  const pnl = rows.reduce((s, r) => s + Number(r.pnl ?? 0), 0)
  const lastBalance = rows.length ? Number(rows[rows.length - 1].balance_after ?? 0) : null
  return [
    `Trades: ${rows.length} (W ${wins} / L ${losses} / S ${scratches})`,
    `Win rate: ${wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : "0.0"}%`,
    `Net PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
    lastBalance !== null ? `Bankroll: $${lastBalance.toFixed(2)}` : "",
    `Period: ${label}`,
  ].filter(Boolean).join("\n")
}

// ---------- background loop (summaries + resource watch) ----------

const SUMMARY_STATE_KEY = "notify:lastSummary:v1"

function summaryTick() {
  const now = new Date()
  const state = (() => {
    try { return JSON.parse(kvGet(SUMMARY_STATE_KEY) ?? "{}") as { daily?: string; weekly?: string } } catch { return {} }
  })()
  const today = now.toISOString().slice(0, 10)

  // Daily summary at/after 00:05 UTC for the previous day.
  if (state.daily !== today && now.getUTCHours() === 0 && now.getUTCMinutes() >= 5) {
    notify("summaries", "DAILY SUMMARY", summarize(Date.now() - 86_400_000, "last 24h"))
    kvSet(SUMMARY_STATE_KEY, JSON.stringify({ ...state, daily: today }))
  }
  // Weekly summary on Monday (UTC).
  if (now.getUTCDay() === 1 && state.weekly !== today && now.getUTCHours() === 0 && now.getUTCMinutes() >= 10) {
    notify("summaries", "WEEKLY SUMMARY", summarize(Date.now() - 7 * 86_400_000, "last 7 days"))
    kvSet(SUMMARY_STATE_KEY, JSON.stringify({ ...state, daily: today, weekly: today }))
  }
}

function resourceTick() {
  try {
    // Memory: warn when RSS exceeds 85% of total system memory.
    const rss = process.memoryUsage().rss
    const total = os.totalmem()
    if (total > 0 && rss / total > 0.85) {
      notify("system", "MEMORY WARNING", `Process RSS ${(rss / 1048576).toFixed(0)} MB is ${((rss / total) * 100).toFixed(0)}% of system memory`)
      logEvent("warn", `Memory warning: RSS ${(rss / 1048576).toFixed(0)} MB (${((rss / total) * 100).toFixed(0)}% of total)`, "system")
    }
    // CPU: 5-minute load average vs core count.
    const cores = os.cpus().length || 1
    const load5 = os.loadavg()[1]
    if (load5 / cores > 0.9) {
      notify("system", "CPU WARNING", `5-min load ${load5.toFixed(2)} on ${cores} core(s) (${((load5 / cores) * 100).toFixed(0)}%)`)
      logEvent("warn", `CPU warning: 5-min load ${load5.toFixed(2)} on ${cores} core(s)`, "system")
    }
  } catch {
    /* resource sampling is best-effort */
  }
}

// ---------- singleton wiring ----------

const globalRef = globalThis as unknown as { __botNotifierV2?: { timer: ReturnType<typeof setInterval> } }

/** Boot the notifier: event subscription, summary scheduler, resource watch, restart detection. */
export function initNotifier() {
  if (globalRef.__botNotifierV2) return

  // Critical errors flow automatically from the event system — no per-site wiring.
  onEvent((level, category, msg) => {
    if (level === "error") notify("errors", "CRITICAL ERROR", msg)
    else if (level === "warn" && category === "recovery") notify("recovery", "RECOVERY EVENT", msg)
  })

  // PROCESS RESTART detection: any notifier boot IS a process start —
  // distinguishes a fresh VPS boot (low os.uptime) from a PM2 restart.
  const osUp = os.uptime()
  const kind = osUp < 300 ? "VPS RESTART" : "PROCESS START (PM2 restart or deploy)"
  notify("lifecycle", kind, `Host up ${(osUp / 3600).toFixed(1)}h · Node ${process.version}`)

  const timer = setInterval(() => {
    summaryTick()
    resourceTick()
  }, 60_000)
  // Never keep the process alive solely for notifications.
  if (typeof timer.unref === "function") timer.unref()
  globalRef.__botNotifierV2 = { timer }
  logEvent("info", "Operations notifier online (Telegram push, category-gated)", "system")
}
