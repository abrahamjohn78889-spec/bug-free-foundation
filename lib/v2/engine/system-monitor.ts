import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { dbStats } from "./db"

/** Engine version stamp — bump alongside major engine milestones. */
const ENGINE_VERSION = "v19"

const execFileAsync = promisify(execFile)

// ------------------------------------------------------------
// System health snapshot for the dashboard monitoring panel.
// Read-only; every probe is individually fault-isolated so a
// missing binary (git, df) can never break the endpoint.
// ------------------------------------------------------------

export interface SystemInfo {
  cpu: { cores: number; load1: number; load5: number; load15: number; usagePct: number }
  memory: { totalBytes: number; freeBytes: number; usedPct: number; processRssBytes: number; heapUsedBytes: number }
  disk: { totalBytes: number; freeBytes: number; usedPct: number } | null
  uptime: { processSec: number; osSec: number }
  node: string
  pm2: { managed: boolean; name: string | null }
  git: { commit: string | null; branch: string | null }
  vpsTimeIso: string
  engineVersion: string
  db: { fileSizeBytes: number; walSizeBytes: number; tradeCount: number; lastBackupAt: string | null }
}

// git info changes only on deploy — cache for the process lifetime.
let gitCache: { commit: string | null; branch: string | null } | null = null

async function gitInfo(): Promise<{ commit: string | null; branch: string | null }> {
  if (gitCache) return gitCache
  let commit: string | null = null
  let branch: string | null = null
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { timeout: 3000 })
    commit = stdout.trim() || null
  } catch { /* not a git checkout */ }
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 3000 })
    branch = stdout.trim() || null
  } catch { /* not a git checkout */ }
  gitCache = { commit, branch }
  return gitCache
}

async function diskInfo(): Promise<SystemInfo["disk"]> {
  try {
    const stat = await fs.promises.statfs(path.resolve(process.cwd()))
    const total = stat.blocks * stat.bsize
    const free = stat.bavail * stat.bsize
    return { totalBytes: total, freeBytes: free, usedPct: total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : 0 }
  } catch {
    return null
  }
}

// CPU usage sampled via process.cpuUsage deltas between calls.
let lastCpu = process.cpuUsage()
let lastCpuAt = Date.now()

function cpuUsagePct(): number {
  const now = Date.now()
  const cur = process.cpuUsage()
  const elapsedUs = Math.max((now - lastCpuAt) * 1000, 1)
  const usedUs = cur.user - lastCpu.user + (cur.system - lastCpu.system)
  lastCpu = cur
  lastCpuAt = now
  const cores = os.cpus().length || 1
  return Math.min(Math.round((usedUs / elapsedUs / cores) * 1000) / 10, 100)
}

export async function systemInfo(): Promise<SystemInfo> {
  const [git, disk] = await Promise.all([gitInfo(), diskInfo()])
  const mem = process.memoryUsage()
  const total = os.totalmem()
  const free = os.freemem()
  const load = os.loadavg()
  let db: SystemInfo["db"] = { fileSizeBytes: 0, walSizeBytes: 0, tradeCount: 0, lastBackupAt: null }
  try {
    const s = dbStats(false)
    db = { fileSizeBytes: s.fileSizeBytes, walSizeBytes: s.walSizeBytes, tradeCount: s.tradeCount, lastBackupAt: s.lastBackupAt }
  } catch { /* db stats are best-effort */ }
  return {
    cpu: {
      cores: os.cpus().length || 1,
      load1: Math.round(load[0] * 100) / 100,
      load5: Math.round(load[1] * 100) / 100,
      load15: Math.round(load[2] * 100) / 100,
      usagePct: cpuUsagePct(),
    },
    memory: {
      totalBytes: total,
      freeBytes: free,
      usedPct: total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : 0,
      processRssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
    },
    disk,
    uptime: { processSec: Math.round(process.uptime()), osSec: Math.round(os.uptime()) },
    node: process.version,
    pm2: {
      managed: Boolean(process.env.PM2_HOME || process.env.pm_id !== undefined),
      name: process.env.name ?? null,
    },
    git,
    vpsTimeIso: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    db,
  }
}
