import type { EngineEvent } from "./types"
import { insertAuditLog } from "./db"

// ------------------------------------------------------------
// Engine event system:
//  • in-memory ring buffer → dashboard Intelligence Feed (fast path)
//  • persisted audit_log rows → filterable/searchable/downloadable history
//  • listener hook → Telegram notifier subscribes for error-level events
// logEvent's (level, msg) signature is unchanged so all existing call
// sites keep working; category is an optional third argument.
// ------------------------------------------------------------

export type AuditCategory =
  | "engine"      // lifecycle: ignite/stop/boot/rollover
  | "trading"     // orders, fills, settlements
  | "risk"        // kill switch, limits, circuit breakers
  | "recovery"    // watchdog, reconnects, adoption, orphan cleanup
  | "auth"        // logins, session events
  | "operator"    // dashboard/Telegram control actions
  | "config"      // configuration changes
  | "system"      // db maintenance, backups, resource warnings
  | "error"       // uncategorized errors

const MAX_EVENTS = 120
const buffer: EngineEvent[] = []

type EventListener = (level: EngineEvent["level"], category: AuditCategory, msg: string) => void
const listeners: EventListener[] = []

/** Subscribe to every logged event (used by the Telegram notifier). */
export function onEvent(fn: EventListener) {
  listeners.push(fn)
}

/** Infer a category from message content for legacy two-arg call sites. */
function inferCategory(level: EngineEvent["level"], msg: string): AuditCategory {
  const m = msg.toLowerCase()
  if (m.includes("kill switch") || m.includes("risk") || m.includes("circuit")) return "risk"
  if (m.includes("watchdog") || m.includes("reconnect") || m.includes("recover") || m.includes("adopted") || m.includes("orphan") || m.includes("reconcil")) return "recovery"
  if (m.includes("login") || m.includes("session") || m.includes("auth")) return "auth"
  if (m.includes("backup") || m.includes("maintenance") || m.includes("memory") || m.includes("database") || m.includes("wal")) return "system"
  if (m.includes("order") || m.includes("fill") || m.includes("settle") || m.includes("trade") || m.includes("standing limit") || m.includes("position")) return "trading"
  if (level === "error") return "error"
  return "engine"
}

export function logEvent(level: EngineEvent["level"], msg: string, category?: AuditCategory) {
  const ev: EngineEvent = { tsMs: Date.now(), level, msg }
  buffer.push(ev)
  if (buffer.length > MAX_EVENTS) buffer.shift()
  const tag = level === "error" ? "ERROR" : level === "warn" ? "WARN" : level.toUpperCase()
  console.log(`[edge5][${tag}] ${msg}`)

  const cat = category ?? inferCategory(level, msg)
  // Persist warn/error always; info only when explicitly categorized (keeps
  // the audit log high-signal — the ring buffer still carries all info chatter).
  if (level !== "info" || category) insertAuditLog(level, cat, msg)

  for (const fn of listeners) {
    try {
      fn(level, cat, msg)
    } catch {
      /* a listener must never break logging */
    }
  }
}

export function recentEvents(limit = 40): EngineEvent[] {
  return buffer.slice(-limit).reverse()
}
