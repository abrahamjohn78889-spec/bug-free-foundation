/**
 * STRATEGY PROFILES — operator convenience layer over the frozen engine.
 *
 * Persists named snapshots of every configurable strategy option in SQLite
 * and re-applies them through the SAME public engine setters the dashboard
 * control API uses. This module:
 *
 *   • NEVER starts the engine (loading a profile only writes configuration;
 *     the operator must always press START manually).
 *   • REFUSES to apply while the engine is running — live trading config
 *     must never change out from under an active pipeline.
 *   • Tracks "profile sessions" (which profile was active from when to when)
 *     so analytics can attribute trades to profiles by timestamp WITHOUT
 *     touching the certified insertTrade/settlement paths.
 */

import { getDbHandle as getDb, kvGet, kvSet } from "./db"
import { logEvent } from "./events"
import type { Edge5Engine as BotEngine } from "./engine"
import type { PipelineMode, SloSizingMode, StrategyId, StrategyParams, TIF, TriggerMode } from "./types"

/** Everything a profile persists. Additive — unknown future keys survive round trips. */
export interface ProfileConfig {
  mode: PipelineMode
  p1Band: { min: number; max: number }
  p2Band: { min: number; max: number }
  driftPaddingUsd: number
  tif: TIF
  p1WindowMs: number
  priceFloor: number
  priceCeil: number
  activeStrategy: StrategyId | null
  strategyParams: Record<string, StrategyParams>
  /** Standing Limit Order configuration, or null when no SLO is set. */
  slo: {
    limitPrice: number
    triggerPrice: number
    triggerMode: TriggerMode
    minPrice: number
    maxPrice: number
    sizingMode: SloSizingMode
    sizeValue: number
    entryWindowSec: number | null
  } | null
  riskLimits: {
    maxDailyLossUsd: number
    maxOrderNotionalUsd: number
    maxDailyOrders: number
    maxSharesPerOrder: number
  }
}

export interface StrategyProfile {
  id: number
  name: string
  notes: string
  config: ProfileConfig
  createdAtMs: number
  updatedAtMs: number
  lastUsedAtMs: number | null
}

const ACTIVE_PROFILE_KEY = "profiles:active-name"

function ensureTables() {
  const d = getDb()
  d.exec(`
    CREATE TABLE IF NOT EXISTS strategy_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      notes TEXT NOT NULL DEFAULT '',
      config_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      last_used_at_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS profile_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_name TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_profile ON profile_sessions(profile_name, started_at_ms);
  `)
  return d
}

interface ProfileRow {
  id: number
  name: string
  notes: string
  config_json: string
  created_at_ms: number
  updated_at_ms: number
  last_used_at_ms: number | null
}

function rowToProfile(r: ProfileRow): StrategyProfile {
  return {
    id: r.id,
    name: r.name,
    notes: r.notes,
    config: JSON.parse(r.config_json) as ProfileConfig,
    createdAtMs: r.created_at_ms,
    updatedAtMs: r.updated_at_ms,
    lastUsedAtMs: r.last_used_at_ms,
  }
}

/** Capture every configurable option from the engine's live snapshot. */
export function captureCurrentConfig(engine: BotEngine): ProfileConfig {
  const s = engine.snapshot()
  const slo = s.standingLimitOrder
  return {
    mode: s.mode,
    p1Band: { min: s.config.p1Band.min, max: s.config.p1Band.max },
    p2Band: { min: s.config.p2Band.min, max: s.config.p2Band.max },
    driftPaddingUsd: s.config.driftPaddingUsd,
    tif: s.config.tif,
    p1WindowMs: s.config.p1WindowMs,
    priceFloor: s.config.priceFloor,
    priceCeil: s.config.priceCeil,
    activeStrategy: s.config.activeStrategy,
    strategyParams: s.config.strategyParams,
    slo: slo
      ? {
          limitPrice: slo.limitPrice,
          triggerPrice: slo.triggerPrice,
          triggerMode: slo.triggerMode,
          minPrice: slo.minPrice,
          maxPrice: slo.maxPrice,
          sizingMode: slo.sizingMode,
          sizeValue: slo.sizeValue,
          entryWindowSec: slo.entryWindowMs === null ? null : Math.round(slo.entryWindowMs / 1000),
        }
      : null,
    riskLimits: { ...s.risk.limits },
  }
}

/**
 * Apply a profile through the public engine setters — the exact same seams
 * the dashboard control API uses. Never starts the engine. Refuses while
 * running so live trading configuration can never change mid-flight.
 */
export function applyConfig(engine: BotEngine, cfg: ProfileConfig): { ok: boolean; message: string } {
  if (engine.snapshot().running) {
    return { ok: false, message: "Engine is RUNNING. Stop the engine before loading a profile." }
  }
  const applied: string[] = []
  engine.setMode(cfg.mode)
  applied.push(`mode=${cfg.mode}`)
  engine.setBands(cfg.p1Band, cfg.p2Band)
  engine.setDriftPadding(cfg.driftPaddingUsd)
  engine.setTif(cfg.tif)
  engine.setP1Window(cfg.p1WindowMs)
  engine.setPriceRange(cfg.priceFloor, cfg.priceCeil)
  engine.setStrategy(cfg.activeStrategy)
  applied.push(`strategy=${cfg.activeStrategy ?? "none"}`)
  for (const [id, params] of Object.entries(cfg.strategyParams ?? {})) {
    engine.setStrategyParams(id as StrategyId, params)
  }
  if (cfg.slo) {
    engine.setLimitOrder(
      cfg.slo.limitPrice,
      cfg.slo.sizingMode === "FIXED_SHARES" ? cfg.slo.sizeValue : 0,
      cfg.slo.minPrice,
      cfg.slo.maxPrice,
      cfg.slo.triggerPrice,
      cfg.slo.triggerMode,
      { sizingMode: cfg.slo.sizingMode, sizeValue: cfg.slo.sizeValue, entryWindowSec: cfg.slo.entryWindowSec },
    )
    applied.push(`SLO trigger=${cfg.slo.triggerPrice} limit=${cfg.slo.limitPrice}`)
  } else {
    engine.clearLimitOrder()
    applied.push("SLO cleared")
  }
  engine.setRiskLimits(cfg.riskLimits)
  return { ok: true, message: `Profile applied (${applied.join(", ")}). Engine NOT started — press START to trade.` }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listProfiles(): StrategyProfile[] {
  const d = ensureTables()
  const rows = d.prepare(`SELECT * FROM strategy_profiles ORDER BY last_used_at_ms DESC NULLS LAST, name ASC`).all() as ProfileRow[]
  return rows.map(rowToProfile)
}

export function getProfile(name: string): StrategyProfile | null {
  const d = ensureTables()
  const row = d.prepare(`SELECT * FROM strategy_profiles WHERE name = ?`).get(name) as ProfileRow | undefined
  return row ? rowToProfile(row) : null
}

export function createProfile(name: string, config: ProfileConfig, notes = ""): StrategyProfile {
  const trimmed = name.trim()
  if (!trimmed) throw new Error("Profile name is required")
  if (trimmed.length > 60) throw new Error("Profile name must be 60 characters or fewer")
  const d = ensureTables()
  const now = Date.now()
  try {
    d.prepare(
      `INSERT INTO strategy_profiles (name, notes, config_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)`,
    ).run(trimmed, notes.slice(0, 500), JSON.stringify(config), now, now)
  } catch (e) {
    if ((e as Error).message.includes("UNIQUE")) throw new Error(`A profile named "${trimmed}" already exists`)
    throw e
  }
  logEvent("info", `Strategy profile created: ${trimmed}`, "system")
  return getProfile(trimmed)!
}

export function saveProfileConfig(name: string, config: ProfileConfig, notes?: string): StrategyProfile {
  const d = ensureTables()
  const existing = getProfile(name)
  if (!existing) throw new Error(`Profile "${name}" not found`)
  d.prepare(`UPDATE strategy_profiles SET config_json = ?, notes = COALESCE(?, notes), updated_at_ms = ? WHERE name = ?`).run(
    JSON.stringify(config),
    notes === undefined ? null : notes.slice(0, 500),
    Date.now(),
    name,
  )
  logEvent("info", `Strategy profile updated: ${name}`, "system")
  return getProfile(name)!
}

export function renameProfile(oldName: string, newName: string): StrategyProfile {
  const trimmed = newName.trim()
  if (!trimmed) throw new Error("New profile name is required")
  const d = ensureTables()
  if (!getProfile(oldName)) throw new Error(`Profile "${oldName}" not found`)
  if (getProfile(trimmed)) throw new Error(`A profile named "${trimmed}" already exists`)
  d.prepare(`UPDATE strategy_profiles SET name = ?, updated_at_ms = ? WHERE name = ?`).run(trimmed, Date.now(), oldName)
  // Keep session attribution intact across renames.
  d.prepare(`UPDATE profile_sessions SET profile_name = ? WHERE profile_name = ?`).run(trimmed, oldName)
  if (kvGet(ACTIVE_PROFILE_KEY) === oldName) kvSet(ACTIVE_PROFILE_KEY, trimmed)
  logEvent("info", `Strategy profile renamed: ${oldName} → ${trimmed}`, "system")
  return getProfile(trimmed)!
}

export function duplicateProfile(sourceName: string, newName: string): StrategyProfile {
  const src = getProfile(sourceName)
  if (!src) throw new Error(`Profile "${sourceName}" not found`)
  return createProfile(newName, src.config, src.notes)
}

export function deleteProfile(name: string): void {
  const d = ensureTables()
  const res = d.prepare(`DELETE FROM strategy_profiles WHERE name = ?`).run(name)
  if (res.changes === 0) throw new Error(`Profile "${name}" not found`)
  if (kvGet(ACTIVE_PROFILE_KEY) === name) kvSet(ACTIVE_PROFILE_KEY, "")
  logEvent("info", `Strategy profile deleted: ${name}`, "system")
}

// ---------------------------------------------------------------------------
// Load + session attribution
// ---------------------------------------------------------------------------

/**
 * Load a profile: apply its config to the (stopped) engine, stamp last-used,
 * close any open session and open a new one. NEVER starts the engine.
 */
export function loadProfile(engine: BotEngine, name: string): { ok: boolean; message: string } {
  const profile = getProfile(name)
  if (!profile) return { ok: false, message: `Profile "${name}" not found` }
  const result = applyConfig(engine, profile.config)
  if (!result.ok) return result
  const d = ensureTables()
  const now = Date.now()
  d.prepare(`UPDATE strategy_profiles SET last_used_at_ms = ? WHERE name = ?`).run(now, name)
  d.prepare(`UPDATE profile_sessions SET ended_at_ms = ? WHERE ended_at_ms IS NULL`).run(now)
  d.prepare(`INSERT INTO profile_sessions (profile_name, started_at_ms) VALUES (?, ?)`).run(name, now)
  kvSet(ACTIVE_PROFILE_KEY, name)
  logEvent("info", `Strategy profile loaded: ${name} (engine NOT started)`, "system")
  return { ok: true, message: `Loaded "${name}". ${result.message}` }
}

/** The profile currently marked active (informational only). */
export function getActiveProfileName(): string | null {
  const v = kvGet(ACTIVE_PROFILE_KEY)
  return v && v.length > 0 ? v : null
}

/** All [start, end] windows during which a profile was active. */
export function getProfileSessions(name: string): Array<{ startMs: number; endMs: number | null }> {
  const d = ensureTables()
  const rows = d
    .prepare(`SELECT started_at_ms, ended_at_ms FROM profile_sessions WHERE profile_name = ? ORDER BY started_at_ms ASC`)
    .all(name) as Array<{ started_at_ms: number; ended_at_ms: number | null }>
  return rows.map((r) => ({ startMs: r.started_at_ms, endMs: r.ended_at_ms }))
}
