// ============================================================================
// AUTH BOOT VALIDATION — fail-CLOSED in LIVE, WARN in PAPER (INC-004 PR-001)
// ============================================================================
// Both dashboard sessions (DASHBOARD_PASSWORD) and the mutating control-API
// guard (BOT_CONTROL_TOKEN) are opt-in via env — an unset value silently
// disables auth entirely (see dashboard-auth.ts + api-auth.ts). That is a
// deliberate localhost-dev convenience, but in LIVE_V2 real-money mode a
// misconfigured deploy would ship a fully open kill-switch, risk-limits, and
// standing-order control plane. This module is the boot gate that refuses
// LIVE ignition when either secret is missing.
//
// Behaviour:
//   • LIVE_V2:
//       - DASHBOARD_PASSWORD missing → boot refused (error).
//       - BOT_CONTROL_TOKEN missing  → boot refused (error).
//   • PAPER_V1:
//       - Missing secrets are allowed. Emit a WARN per missing secret and a
//         summary WARN reminding the operator that auth is disabled.
//   • ALLOW_UNAUTH=1 escape hatch:
//       - Honoured ONLY when NODE_ENV=development. Bypasses the LIVE gate,
//         still warns.
//       - Set in any other environment → boot refused, regardless of mode.
//         (A rogue ALLOW_UNAUTH=1 in prod would otherwise silently defeat
//         the whole point of this file.)
//
// Pure module. Reads only the injected env snapshot; the caller decides how
// to surface the result (throw, return error string, log, etc.) so this file
// stays trivially testable and side-effect free.
// ============================================================================

import type { PipelineMode } from "./types"

/** Secrets governed by this gate. Add here first, then extend the audit. */
const REQUIRED_LIVE_SECRETS = [
  {
    name: "DASHBOARD_PASSWORD",
    purpose: "dashboard session authentication (login form + session cookies)",
  },
  {
    name: "BOT_CONTROL_TOKEN",
    purpose: "mutating control-API shared-secret guard (start/stop, kill switch, risk limits, standing orders)",
  },
] as const

export interface AuthBootReport {
  /** True when boot MAY proceed. False means refuse startup. */
  ok: boolean
  /** Human-readable blocking errors. Never empty when ok=false. */
  errors: string[]
  /** Human-readable non-blocking warnings (PAPER, dev escape hatch). */
  warnings: string[]
  /** Which required secrets were missing (informational). */
  missing: string[]
  /** True when the dev escape hatch was honoured. */
  allowUnauthApplied: boolean
}

/** Minimal env surface — accepts a snapshot so tests never touch process.env. */
export type EnvLike = Readonly<Record<string, string | undefined>>

function isTruthyFlag(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === "1" || s === "true" || s === "yes" || s === "on"
}

function isSet(v: string | undefined): boolean {
  return typeof v === "string" && v.length > 0
}

/**
 * Compute the boot verdict for a given pipeline mode and env snapshot.
 * Pure: no I/O, no logging, no throws. The caller enforces.
 */
export function assertAuthBootConfig(
  mode: PipelineMode,
  envSnapshot: EnvLike = process.env as EnvLike,
): AuthBootReport {
  const errors: string[] = []
  const warnings: string[] = []
  const missing = REQUIRED_LIVE_SECRETS
    .filter((s) => !isSet(envSnapshot[s.name]))
    .map((s) => s.name)

  const allowUnauth = isTruthyFlag(envSnapshot.ALLOW_UNAUTH)
  const nodeEnv = (envSnapshot.NODE_ENV ?? "").trim().toLowerCase()
  const isDev = nodeEnv === "development"

  // Rogue ALLOW_UNAUTH outside development is always fatal — it exists solely
  // as a local-dev convenience and must never silently defeat the LIVE gate.
  if (allowUnauth && !isDev) {
    errors.push(
      `ALLOW_UNAUTH=1 is only honoured when NODE_ENV=development (got NODE_ENV="${envSnapshot.NODE_ENV ?? ""}"). Refusing to start with authentication disabled outside development.`,
    )
    return { ok: false, errors, warnings, missing, allowUnauthApplied: false }
  }

  if (allowUnauth && isDev) {
    warnings.push(
      "ALLOW_UNAUTH=1 (NODE_ENV=development): authentication boot checks bypassed. Never set this flag outside local development.",
    )
    if (missing.length > 0) {
      warnings.push(
        `The following auth secret(s) are unset but ignored under ALLOW_UNAUTH: ${missing.join(", ")}.`,
      )
    }
    return { ok: true, errors, warnings, missing, allowUnauthApplied: true }
  }

  if (mode === "LIVE_V2") {
    for (const s of REQUIRED_LIVE_SECRETS) {
      if (!isSet(envSnapshot[s.name])) {
        errors.push(
          `Refusing LIVE_V2 startup: ${s.name} is not set — required for ${s.purpose}. Set the secret and retry, or run in PAPER_V1.`,
        )
      }
    }
    return { ok: errors.length === 0, errors, warnings, missing, allowUnauthApplied: false }
  }

  // PAPER_V1: allow, but WARN loudly per missing secret + a summary reminder.
  if (missing.length > 0) {
    for (const s of REQUIRED_LIVE_SECRETS) {
      if (!isSet(envSnapshot[s.name])) {
        warnings.push(
          `[PAPER_V1] ${s.name} is not set — ${s.purpose} is DISABLED. Requests to protected surfaces will be accepted without credentials.`,
        )
      }
    }
    warnings.push(
      `[PAPER_V1] Authentication is disabled for ${missing.length} of ${REQUIRED_LIVE_SECRETS.length} surface(s). This is tolerated in PAPER mode ONLY. Set ${missing.join(" + ")} before switching to LIVE_V2.`,
    )
  }
  return { ok: true, errors, warnings, missing, allowUnauthApplied: false }
}

/**
 * Enforce the boot verdict against the current process.
 *
 * - On failure returns a single human-readable string containing every error;
 *   the caller (engine.start()) surfaces it via the same channel as other
 *   startup failures ("Already running", buildExecutor error, etc.). This
 *   keeps the return-shape uniform for the control API caller.
 * - On success returns null; every warning has been logged via `emit`.
 *
 * `emit` is injected so this module can stay import-safe for unit tests
 * (default routes through the engine's structured logger).
 */
export function enforceAuthBoot(
  mode: PipelineMode,
  emit: (level: "warn" | "error", msg: string) => void,
  envSnapshot: EnvLike = process.env as EnvLike,
): string | null {
  const report = assertAuthBootConfig(mode, envSnapshot)
  for (const w of report.warnings) emit("warn", `[AUTH-BOOT] ${w}`)
  if (!report.ok) {
    const combined = report.errors.map((e) => `[AUTH-BOOT] ${e}`).join(" | ")
    emit("error", combined)
    return combined
  }
  return null
}