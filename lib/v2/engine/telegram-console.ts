/**
 * TELEGRAM REMOTE COMMAND CONSOLE — production operations console.
 *
 * Long-polls the Telegram getUpdates API on the VPS and routes authorized
 * commands to the engine. Design constraints:
 *
 *   • AUTHORIZATION: only the configured TELEGRAM_CHAT_ID (plus optional
 *     TELEGRAM_ADMIN_CHAT_IDS, comma-separated) may run ANY command. Unknown
 *     senders are rejected and the attempt is audit-logged. This is on top
 *     of Telegram's own bot-token secrecy; the dashboard BOT_CONTROL_TOKEN
 *     protections are untouched (this path never goes through HTTP routes —
 *     it calls the same public engine methods the control route uses).
 *   • READ vs CONTROL separation: control commands (/start /stop /kill) are
 *     explicitly tagged, audit-logged with the sender id, and confirmed in
 *     the reply. Read-only commands never mutate anything.
 *   • ISOLATION: the poller is fully fire-and-forget. A Telegram outage,
 *     malformed update, or handler bug can never touch the trading path —
 *     every cycle is wrapped, and errors back off exponentially.
 *   • SINGLETON: guarded via globalThis so dev-mode HMR and multiple imports
 *     can never spawn duplicate pollers (which would double-consume updates).
 */

import { env } from "./config"
import { insertAuditLog } from "./db"
import { logEvent } from "./events"

const POLL_TIMEOUT_SEC = 25
const ERROR_BACKOFF_START_MS = 5_000
const ERROR_BACKOFF_MAX_MS = 300_000
const MAX_MESSAGE_LEN = 4_000

interface TgUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number; username?: string }
    chat: { id: number }
    text?: string
  }
}

function authorizedChatIds(): Set<string> {
  const ids = new Set<string>()
  if (env.TELEGRAM_CHAT_ID) ids.add(String(env.TELEGRAM_CHAT_ID).trim())
  for (const id of (process.env.TELEGRAM_ADMIN_CHAT_IDS || "").split(",")) {
    const t = id.trim()
    if (t) ids.add(t)
  }
  return ids
}

const READ_COMMANDS = new Set([
  "/help", "/status", "/health", "/balance", "/pnl", "/trades", "/openorders",
  "/analytics", "/system", "/logs", "/version", "/report",
])
const CONTROL_COMMANDS = new Set(["/start", "/stop", "/kill"])

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`
const esc = (s: string) => s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))

export class TelegramConsole {
  private offset = 0
  private stopped = false
  private backoffMs = ERROR_BACKOFF_START_MS
  private abort: AbortController | null = null

  start() {
    void this.loop()
  }

  stop() {
    this.stopped = true
    // Interrupt an in-flight long poll immediately — without this, the loop
    // can keep running for up to POLL_TIMEOUT_SEC after stop() is called.
    this.abort?.abort()
  }

  private async loop() {
    while (!this.stopped) {
      try {
        this.abort = new AbortController()
        const timeout = setTimeout(() => this.abort?.abort(), (POLL_TIMEOUT_SEC + 10) * 1000)
        let res: Response
        try {
          res = await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?timeout=${POLL_TIMEOUT_SEC}&offset=${this.offset}&allowed_updates=%5B%22message%22%5D`,
            { signal: this.abort.signal },
          )
        } finally {
          clearTimeout(timeout)
        }
        if (this.stopped) return
        if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`)
        const data = (await res.json()) as { ok: boolean; result?: TgUpdate[] }
        if (!data.ok) throw new Error("getUpdates returned ok=false")
        this.backoffMs = ERROR_BACKOFF_START_MS
        for (const u of data.result ?? []) {
          if (this.stopped) return
          this.offset = Math.max(this.offset, u.update_id + 1)
          // Each command is fully isolated — one bad handler never stalls the loop.
          try {
            await this.handleUpdate(u)
          } catch (e) {
            logEvent("error", `Telegram command handler failed: ${(e as Error).message}`, "system")
          }
        }
      } catch (e) {
        if (this.stopped) return
        logEvent("warn", `Telegram console poll error (backing off ${Math.round(this.backoffMs / 1000)}s): ${(e as Error).message}`, "system")
        await new Promise((r) => setTimeout(r, this.backoffMs))
        this.backoffMs = Math.min(this.backoffMs * 2, ERROR_BACKOFF_MAX_MS)
      }
    }
  }

  private async send(chatId: string | number, html: string) {
    const text = html.length > MAX_MESSAGE_LEN ? html.slice(0, MAX_MESSAGE_LEN) + "\n…(truncated)" : html
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {})
  }

  private async handleUpdate(u: TgUpdate) {
    const msg = u.message
    if (!msg?.text) return
    const chatId = String(msg.chat.id)
    const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase()
    if (!cmd.startsWith("/")) return

    // ---- Authorization: unknown users are rejected, always ----
    if (!authorizedChatIds().has(chatId)) {
      insertAuditLog("warn", "system", `Telegram: REJECTED command ${cmd} from unauthorized chat ${chatId} (@${msg.from?.username ?? "?"})`)
      await this.send(msg.chat.id, "⛔ Unauthorized. This incident has been logged.")
      return
    }

    if (CONTROL_COMMANDS.has(cmd)) {
      insertAuditLog("info", "system", `Telegram CONTROL command ${cmd} by chat ${chatId}`)
    }

    if (!READ_COMMANDS.has(cmd) && !CONTROL_COMMANDS.has(cmd)) {
      await this.send(msg.chat.id, `Unknown command <code>${esc(cmd)}</code>. Send /help for the command list.`)
      return
    }

    const reply = await this.execute(cmd)
    await this.send(msg.chat.id, reply)
  }

  /** Route a validated, authorized command. Lazily imports the engine. */
  private async execute(cmd: string): Promise<string> {
    const { getEngine } = await import("./engine")
    const engine = getEngine()
    const snap = engine.snapshot()

    switch (cmd) {
      case "/help":
        return [
          "<b>EDGE 5 — REMOTE CONSOLE</b>",
          "",
          "<b>Read-only</b>",
          "/status — engine + market state",
          "/health — feeds, watchdog, clock",
          "/balance — bankroll + dust reserve",
          "/pnl — session + total PnL",
          "/trades — last 5 settled trades",
          "/openorders — resting/armed orders",
          "/analytics — full-ledger stats",
          "/system — VPS CPU/RAM/disk/uptime",
          "/logs — last 10 audit entries",
          "/version — build + commit",
          "/report — exact 24h performance report",
          "",
          "<b>Control</b> (audit-logged)",
          "/start — ignite the engine",
          "/stop — stop the engine",
          "/kill — engage the kill switch",
        ].join("\n")

      case "/status": {
        const slo = snap.standingLimitOrder
        return [
          `<b>STATUS</b> — ${snap.mode}`,
          `Engine: ${snap.running ? "🟢 RUNNING" : "🔴 STOPPED"}  Phase: ${snap.phase}`,
          `Market: ${snap.liveMarket ? esc(snap.liveMarket.slug) : "—"}`,
          `Settles in: ${Math.max(0, Math.round(snap.tMinusMs / 1000))}s`,
          `UP ${snap.upTokenPrice?.toFixed(2) ?? "—"} / DOWN ${snap.downTokenPrice?.toFixed(2) ?? "—"}`,
          slo ? `SLO: ${slo.status} (trigger ${slo.triggerPrice.toFixed(2)} → limit ${slo.limitPrice.toFixed(2)})` : "SLO: none",
          snap.risk.killSwitch.engaged ? `⚠ KILL SWITCH: ${esc(snap.risk.killSwitch.reason)}` : "",
        ].filter(Boolean).join("\n")
      }

      case "/health": {
        const { systemInfo } = await import("./system-monitor")
        const sys = await systemInfo()
        return [
          `<b>HEALTH</b>`,
          `Clock: ${snap.clockSynced ? "synced" : "NOT SYNCED"} (offset ${snap.clockOffsetMs.toFixed(0)}ms)`,
          `CLOB feed: ${snap.upTokenPrice !== null ? "🟢 live" : "🔴 no data"}`,
          `Market discovery: ${snap.marketDiscovery ?? "n/a (paper)"}`,
          `Process uptime: ${Math.floor(sys.uptime.processSec / 3600)}h ${Math.floor((sys.uptime.processSec % 3600) / 60)}m`,
          `PM2: ${sys.pm2.managed ? `managed (${esc(sys.pm2.name ?? "?")})` : "not managed"}`,
        ].join("\n")
      }

      case "/balance":
        return [
          `<b>BANKROLL</b> — ${snap.mode}`,
          `Balance: ${usd(snap.balance)}`,
          `Dust reserve: ${usd(snap.dustReserve)}`,
          `Capital pool: ${usd(snap.balance + snap.dustReserve)}`,
          `Starting: ${usd(snap.startingBalance)}`,
        ].join("\n")

      case "/pnl": {
        const roi = snap.startingBalance > 0 ? ((snap.balance + snap.dustReserve - snap.startingBalance) / snap.startingBalance) * 100 : 0
        return [
          `<b>PNL</b> — ${snap.mode}`,
          `Total PnL: ${usd(snap.totalPnl)}`,
          `ROI: ${roi.toFixed(1)}%`,
          `Record: ${snap.wins}W / ${snap.losses}L`,
        ].join("\n")
      }

      case "/trades": {
        const { recentTrades } = await import("./db")
        const rows = recentTrades(snap.mode, 5)
        if (rows.length === 0) return "No settled trades yet."
        return [
          `<b>LAST ${rows.length} TRADES</b> — ${snap.mode}`,
          ...rows.map(
            (t) =>
              `${t.result === "WIN" ? "🟢" : t.result === "LOSS" ? "🔴" : "⚪"} ${t.side} ${t.shares}sh @ ${t.price.toFixed(2)} → ${t.result} ${usd(t.pnl)}`,
          ),
        ].join("\n")
      }

      case "/openorders": {
        const slo = snap.standingLimitOrder
        const open = snap.openOrder
        const lines = [`<b>OPEN ORDERS</b> — ${snap.mode}`]
        lines.push(open ? `Resting: ${open.side} ${open.shares}sh @ ${open.price.toFixed(2)}` : "Resting: none")
        lines.push(
          slo
            ? `SLO: ${slo.status} — trigger ${slo.triggerPrice.toFixed(2)} → limit ${slo.limitPrice.toFixed(2)} (${slo.sizingMode} ${slo.sizeValue})`
            : "SLO: none",
        )
        return lines.join("\n")
      }

      case "/analytics": {
        const { computeAnalytics } = await import("./analytics")
        const a = computeAnalytics(snap.mode)
        return [
          `<b>ANALYTICS</b> — ${snap.mode} (full ledger)`,
          `Trades: ${a.totalTrades}  W/L/S: ${a.wins}/${a.losses}/${a.scratches}`,
          `Win rate: ${a.winRate.toFixed(1)}%  PF: ${a.profitFactor !== null && Number.isFinite(a.profitFactor) ? a.profitFactor.toFixed(2) : a.profitFactor === null ? "—" : "∞"}`,
          `Net: ${usd(a.totalReturnUsd)}  ROI: ${a.roiPct !== null ? a.roiPct.toFixed(1) + "%" : "—"}`,
          `Max DD: ${a.maxDrawdownPct !== null ? a.maxDrawdownPct.toFixed(1) + "%" : "—"}`,
          `Best/Worst: ${usd(a.largestWinUsd)} / ${usd(a.largestLossUsd)}`,
          `Streaks: ${a.longestWinStreak}W / ${a.longestLossStreak}L`,
        ].join("\n")
      }

      case "/system": {
        const { systemInfo } = await import("./system-monitor")
        const { dbStats } = await import("./db")
        const sys = await systemInfo()
        const stats = dbStats(false)
        return [
          `<b>SYSTEM</b>`,
          `CPU: ${sys.cpu.usagePct.toFixed(0)}% (${sys.cpu.cores} cores, load5 ${sys.cpu.load5.toFixed(2)})`,
          `RAM: ${sys.memory.usedPct.toFixed(0)}% — proc ${(sys.memory.processRssBytes / 1048576).toFixed(0)} MB`,
          sys.disk ? `Disk: ${sys.disk.usedPct.toFixed(0)}% (${(sys.disk.freeBytes / 1073741824).toFixed(1)} GB free)` : "Disk: —",
          `DB: ${(stats.fileSizeBytes / 1048576).toFixed(1)} MB (${stats.tradeCount} trades)`,
          `Host uptime: ${Math.floor(sys.uptime.osSec / 86400)}d  Process: ${Math.floor(sys.uptime.processSec / 3600)}h`,
          `Node ${esc(sys.node)}`,
        ].join("\n")
      }

      case "/logs": {
        const { queryAuditLog } = await import("./db")
        const rows = queryAuditLog({ limit: 10 })
        if (rows.length === 0) return "Audit log is empty."
        return [
          "<b>LAST 10 AUDIT ENTRIES</b>",
          ...rows.map((r) => `<code>${new Date(r.tsMs).toISOString().slice(11, 19)}</code> [${r.level}] ${esc(r.message.slice(0, 120))}`),
        ].join("\n")
      }

      case "/version": {
        const { systemInfo } = await import("./system-monitor")
        const sys = await systemInfo()
        return [
          `<b>VERSION</b>`,
          `Engine: ${esc(sys.engineVersion)}`,
          `Commit: ${sys.git.commit ? esc(`${sys.git.branch ?? "?"}@${sys.git.commit}`) : "—"}`,
          `Node: ${esc(sys.node)}`,
          `Pipeline: ${snap.mode}`,
        ].join("\n")
      }

      case "/report": {
        const { build24hReport } = await import("./report")
        return build24hReport(engine)
      }

      // ---- CONTROL COMMANDS (authorized + audit-logged above) ----
      case "/start":
        try {
          return `✅ ${esc(engine.start())}`
        } catch (e) {
          return `❌ Start failed: ${esc((e as Error).message)}`
        }

      case "/stop":
        return `✅ ${esc(engine.stop())}`

      case "/kill":
        return `🛑 ${esc(engine.engageKillSwitch("Telegram /kill command"))}`

      default:
        return "Unknown command. Send /help."
    }
  }
}

/**
 * Start the console once per process. No-op unless both TELEGRAM_BOT_TOKEN
 * and TELEGRAM_CHAT_ID are configured. Safe to call multiple times.
 */
export function startTelegramConsole(): boolean {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false
  const g = globalThis as { __edge5TelegramConsole?: TelegramConsole }
  if (g.__edge5TelegramConsole) return true
  g.__edge5TelegramConsole = new TelegramConsole()
  g.__edge5TelegramConsole.start()
  logEvent("info", "Telegram remote command console started (long polling)", "system")
  return true
}
