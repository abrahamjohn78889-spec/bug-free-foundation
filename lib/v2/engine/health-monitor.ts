// ============================================================================
// HEALTH MONITOR — in-process production monitor. Polls computeHealth() every
// 30s and pushes Telegram alerts (via notifier) on:
//
//   • Any subsystem transitioning from OK → NOT OK  (immediate notification)
//   • Any subsystem staying NOT OK for ≥ 2 consecutive checks (sustained fault)
//   • Recovery: transitioning back from NOT OK → OK
//
// Category routing:
//   • execution / user_ws / fills / market_ws / quotes → "recovery" + "errors"
//   • memory / database / watchdog → "system"
//   • risk (kill switch) → "risk"
//
// The monitor is best-effort and READ-ONLY: it never mutates trading state
// and every callback is guarded so a monitoring failure cannot affect the
// trading path. Auto-boots from initNotifier(); no explicit wiring needed.
// ============================================================================

import { computeHealth } from "./health"
import { notify, type NotifyCategory } from "./notifier"
import { logEvent } from "./events"

const POLL_MS = 30_000
/** A subsystem must fail this many consecutive checks (after the initial
 *  transition alert) before we escalate with a sustained-fault notification. */
const SUSTAINED_THRESHOLD = 2

const CATEGORY_BY_SUBSYSTEM: Record<string, NotifyCategory> = {
  execution: "errors",
  user_ws: "recovery",
  market_ws: "recovery",
  fills: "errors",
  quotes: "recovery",
  watchdog: "system",
  memory: "system",
  database: "errors",
  engine: "errors",
  risk: "risk",
}

interface SubsystemState {
  ok: boolean
  consecutiveFailures: number
  sustainedAlerted: boolean
}

const state = new Map<string, SubsystemState>()
const globalRef = globalThis as unknown as {
  __botHealthMonitorV2?: { timer: ReturnType<typeof setInterval> }
}

function tick() {
  try {
    const report = computeHealth()
    for (const [name, check] of Object.entries(report.checks)) {
      const prev = state.get(name) ?? { ok: true, consecutiveFailures: 0, sustainedAlerted: false }
      const category = CATEGORY_BY_SUBSYSTEM[name] ?? "system"

      if (!check.ok) {
        const failures = prev.consecutiveFailures + 1
        // Alert on the first transition into failure.
        if (prev.ok) {
          notify(category, `HEALTH DEGRADED — ${name}`, check.detail)
          logEvent("warn", `Health check failed [${name}]: ${check.detail}`, "system")
        } else if (failures >= SUSTAINED_THRESHOLD && !prev.sustainedAlerted) {
          // Sustained fault: still down after N consecutive checks.
          notify(
            category,
            `HEALTH SUSTAINED FAULT — ${name}`,
            `Still degraded after ${failures} checks (${Math.round((failures * POLL_MS) / 1000)}s):\n${check.detail}`,
          )
        }
        state.set(name, {
          ok: false,
          consecutiveFailures: failures,
          sustainedAlerted: prev.sustainedAlerted || failures >= SUSTAINED_THRESHOLD,
        })
      } else {
        // Recovery: was down, now up.
        if (!prev.ok) {
          notify(category, `HEALTH RECOVERED — ${name}`, check.detail)
          logEvent("info", `Health check recovered [${name}]: ${check.detail}`, "system")
        }
        state.set(name, { ok: true, consecutiveFailures: 0, sustainedAlerted: false })
      }
    }
  } catch (e) {
    // A monitor failure must never touch the trading path. Log once.
    logEvent("warn", `Health monitor tick failed: ${e instanceof Error ? e.message : String(e)}`, "system")
  }
}

/** Boot the in-process health monitor. Idempotent; auto-called by initNotifier(). */
export function initHealthMonitor() {
  if (globalRef.__botHealthMonitorV2) return
  const timer = setInterval(tick, POLL_MS)
  // Never keep the process alive solely for health polling.
  if (typeof timer.unref === "function") timer.unref()
  globalRef.__botHealthMonitorV2 = { timer }
  logEvent("info", `Health monitor online (poll ${POLL_MS}ms, sustained threshold ${SUSTAINED_THRESHOLD})`, "system")
}
