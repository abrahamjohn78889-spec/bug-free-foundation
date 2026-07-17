import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"
import { env } from "./config"
import type { PipelineMode, SettledTrade, TradeSide } from "./types"

// ------------------------------------------------------------
// Local SQLite ledger (better-sqlite3, synchronous & fast).
// Survives restarts; paper and live trades share one schema
// distinguished by the `mode` column.
// ------------------------------------------------------------

let db: Database.Database | null = null

/**
 * Prepared-statement cache. better-sqlite3's `.prepare()` recompiles the SQL
 * text on every call; hot paths like `updateOpenTradeMark` (per-tick while a
 * position is open) and `kvGet`/`kvSet` (called via Bankroll on every access)
 * benefit meaningfully from statement reuse. Keyed by (db, sql). The cache is
 * invalidated automatically when the db handle is replaced (tests).
 */
const stmtCaches = new WeakMap<Database.Database, Map<string, Database.Statement>>()
function prep(d: Database.Database, sql: string): Database.Statement {
  let cache = stmtCaches.get(d)
  if (!cache) {
    cache = new Map()
    stmtCaches.set(d, cache)
  }
  let stmt = cache.get(sql)
  if (!stmt) {
    stmt = d.prepare(sql)
    cache.set(sql, stmt)
  }
  return stmt
}

/**
 * Queue for database writes to prevent blocking the execution engine.
 * All writes are asynchronously queued and executed in order.
 */
const writeQueue: Array<() => void> = []
let writeProcessing = false

async function processWriteQueue() {
  if (writeProcessing || writeQueue.length === 0) return
  writeProcessing = true
  while (writeQueue.length > 0) {
    const op = writeQueue.shift()
    if (op) {
      try {
        op()
      } catch (e) {
        console.error("[DB] Write queue error:", e)
      }
    }
  }
  writeProcessing = false
}

function queueWrite(op: () => void): void {
  writeQueue.push(op)
  // Use setImmediate to yield to the event loop and ensure execution never waits
  setImmediate(() => void processWriteQueue())
}

/**
 * TESTING ONLY: Flush the write queue synchronously to completion.
 * In production, writes are async and never block execution. In tests,
 * call this before assertions to ensure all queued writes are persisted.
 */
export function flushWriteQueueSync(): void {
  while (writeQueue.length > 0) {
    const op = writeQueue.shift()
    if (op) {
      try {
        op()
      } catch (e) {
        console.error("[DB] Write queue flush error:", e)
      }
    }
  }
}

/**
 * Narrow internal seam for sibling engine modules (strategy profiles,
 * comparison) that manage their own additive tables. Application code and
 * API routes must keep using the typed helpers in this file.
 */
export function getDbHandle(): Database.Database {
  return getDb()
}

function getDb(): Database.Database {
  if (db) return db
  const full = path.resolve(process.cwd(), env.DB_PATH)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  db = new Database(full)
  db.pragma("journal_mode = WAL")
  // LOCK RESILIENCE: wait up to 5s on a contended lock instead of throwing
  // SQLITE_BUSY immediately (e.g. an external sqlite3 CLI inspecting the DB).
  db.pragma("busy_timeout = 5000")
  // Durability/perf balance appropriate for WAL: fsync at checkpoints.
  db.pragma("synchronous = NORMAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      slot_end_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      shares INTEGER NOT NULL,
      cost REAL NOT NULL,
      result TEXT NOT NULL,
      pnl REAL NOT NULL,
      balance_after REAL NOT NULL,
      dust_saved REAL NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades(mode);
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      mode TEXT NOT NULL,
      event TEXT NOT NULL,
      market_id TEXT NOT NULL,
      token_id TEXT,
      exchange_order_id TEXT,
      side TEXT,
      price REAL,
      shares INTEGER,
      phase TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_order_log_market ON order_log(market_id);
    CREATE INDEX IF NOT EXISTS idx_order_log_ts ON order_log(ts_ms);
    -- Composite index for the risk manager's daily order-rate query
    -- (WHERE mode = ? AND event = 'SUBMITTED' AND ts_ms >= ?): without it that
    -- query degrades to a scan as order_log grows over months of operation.
    CREATE INDEX IF NOT EXISTS idx_order_log_mode_event_ts ON order_log(mode, event, ts_ms);
    -- Composite index for daily-loss queries (WHERE mode = ? ... settled_at).
    CREATE INDEX IF NOT EXISTS idx_trades_mode_settled ON trades(mode, settled_at);
    -- Structured audit log: every important event, persisted and queryable.
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts_ms);
    CREATE INDEX IF NOT EXISTS idx_audit_cat_ts ON audit_log(category, ts_ms);
    -- Persistent execution-latency samples: one row per submitted standing
    -- limit order. Publish (submit start) → ack → observed fill. Used by the
    -- /report page to track latency regressions across restarts.
    CREATE TABLE IF NOT EXISTS latency_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      mode TEXT NOT NULL,
      market_id TEXT NOT NULL,
      exchange_order_id TEXT,
      side TEXT,
      shares INTEGER,
      limit_price REAL,
      quote_age_ms INTEGER NOT NULL,
      decision_ms INTEGER NOT NULL,
      pre_submit_ms INTEGER NOT NULL,
      submit_ms INTEGER NOT NULL,
      fill_check_ms INTEGER NOT NULL,
      total_ms INTEGER NOT NULL,
      submit_at_ms INTEGER NOT NULL,
      fill_observed_ms INTEGER,
      filled_price REAL
    );
    CREATE INDEX IF NOT EXISTS idx_latency_mode_ts ON latency_samples(mode, ts_ms);
    CREATE INDEX IF NOT EXISTS idx_latency_order ON latency_samples(exchange_order_id);
  `)

  // ---- Lifecycle migration: open→settled columns (idempotent) ----
  // Existing rows are historical settled trades, so they default to SETTLED.
  const cols = new Set(
    (db.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>).map((c) => c.name),
  )
  const addCol = (name: string, ddl: string) => {
    if (!cols.has(name)) db!.exec(`ALTER TABLE trades ADD COLUMN ${ddl}`)
  }
  addCol("status", "status TEXT NOT NULL DEFAULT 'SETTLED'")
  addCol("order_id", "order_id TEXT")
  addCol("trade_uid", "trade_uid TEXT")
  addCol("entry_at_ms", "entry_at_ms INTEGER")
  addCol("mark_price", "mark_price REAL")
  addCol("unrealized_pnl", "unrealized_pnl REAL")
  // Permanent per-trade audit record (JSON): why the trade opened, why the
  // side was selected, why it settled WIN/LOSS/SCRATCH, and the PnL math.
  addCol("explanation", "explanation TEXT")
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);`)

  // Close any positions that were OPEN when the server last shut down —
  // their in-memory FilledLot is gone so they can never be settled normally.
  // CRITICAL: the bankroll was debited `cost` when each of these filled, and a
  // SCRATCH must refund that cost. Closing them with pnl=0 but WITHOUT the
  // refund silently destroyed money from the pool on every restart with an
  // open position (a phantom loss the ledger could never explain).
  scratchOrphanedOpenRows(db)

  // One-time data fix: settled rows written by older code carried the
  // realized pnl value in unrealized_pnl (a copy bug now corrected in
  // settleTrade). Clear it so the ledger doesn't confuse realized with
  // unrealized amounts on historical rows.
  db.prepare(
    `UPDATE trades SET unrealized_pnl = NULL WHERE status = 'SETTLED' AND unrealized_pnl IS NOT NULL`,
  ).run()

  return db
}

/**
 * Close every OPEN trade row as SCRATCH *with the cost refunded to the mode's
 * bankroll*. Runs at boot (server restarted while positions were live).
 *
 * The pool is debited `cost` at fill time; a SCRATCH settlement must return
 * it. The bankroll lives in the kv table (`bankroll:<mode>:balance`), so the
 * refund is applied directly here — this module cannot import Bankroll
 * (circular dependency), and the same 4-decimal rounding is used.
 */
function scratchOrphanedOpenRows(d: Database.Database) {
  const rows = d
    .prepare(`SELECT id, mode, cost FROM trades WHERE status = 'OPEN'`)
    .all() as Array<{ id: number; mode: string; cost: number }>
  if (rows.length === 0) return

  const kvRead = d.prepare(`SELECT value FROM kv WHERE key = ?`)
  const kvWrite = d.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
  const settleRow = d.prepare(
    `UPDATE trades
       SET status = 'SETTLED', result = 'SCRATCH', pnl = 0, mark_price = NULL, unrealized_pnl = NULL,
           settled_at = datetime('now'), balance_after = ?, explanation = ?
     WHERE id = ? AND status = 'OPEN'`,
  )

  // Refund per mode first, then stamp each row with the post-refund balance.
  // Wrap the write burst in a single transaction so N orphan rows produce one
  // WAL commit at boot instead of N.
  const totals = new Map<string, number>()
  for (const r of rows) totals.set(r.mode, (totals.get(r.mode) ?? 0) + r.cost)
  const finalBalance = new Map<string, number>()
  const applyRefunds = d.transaction(() => {
    for (const [mode, total] of totals) {
      const balKey = `bankroll:${mode}:balance`
      const cur = Number((kvRead.get(balKey) as { value: string } | undefined)?.value ?? 0)
      const next = Math.round((cur + total) * 10000) / 10000
      kvWrite.run(balKey, String(next))
      const dust = Number((kvRead.get(`bankroll:${mode}:dust`) as { value: string } | undefined)?.value ?? 0)
      finalBalance.set(mode, Math.round((next + dust) * 10000) / 10000)
    }
    for (const r of rows) {
      settleRow.run(
        finalBalance.get(r.mode) ?? 0,
        JSON.stringify({
          settlement: "SCRATCH — server restarted while the position was OPEN; the in-memory position was lost and the market outcome could not be verified",
          pnlCalc: `entry cost $${r.cost.toFixed(4)} refunded to the capital pool; realized PnL $0.0000`,
          recovery: "boot-time orphan recovery (cost refund applied)",
        }),
        r.id,
      )
    }
  })
  applyRefunds()
}

export function kvGet(key: string): string | null {
  const row = prep(getDb(), "SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function kvSet(key: string, value: string) {
  prep(getDb(), "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
}

/**
 * Insert a fully-settled trade asynchronously via the write queue.
 * Never blocks execution — the trade is persisted in the background.
 */
export function insertTrade(t: {
  marketId: string
  slotEndMs: number
  side: TradeSide
  price: number
  shares: number
  cost: number
  result: "WIN" | "LOSS" | "SCRATCH"
  pnl: number
  balanceAfter: number
  dustSaved: number
  mode: PipelineMode
  /** JSON audit record: why the trade opened/settled and the PnL math. */
  explanation?: string | null
}): void {
  queueWrite(() => {
    prep(
      getDb(),
      `INSERT INTO trades (market_id, slot_end_ms, side, price, shares, cost, result, pnl, balance_after, dust_saved, mode, status, explanation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SETTLED', ?)`,
    ).run(t.marketId, t.slotEndMs, t.side, t.price, t.shares, t.cost, t.result, t.pnl, t.balanceAfter, t.dustSaved, t.mode, t.explanation ?? null)
  })
}

/**
 * Record an execution the instant it fills. Writes an OPEN row immediately
 * (before market resolution) with full execution data, so it appears in the
 * ledger / transaction history right away. Returns the row id so the caller
 * can update live PnL and later settle this exact row.
 */
export function openTrade(t: {
  marketId: string
  slotEndMs: number
  side: TradeSide
  price: number
  shares: number
  cost: number
  balanceAfter: number
  mode: PipelineMode
  orderId?: string | null
  tradeUid?: string | null
  /** JSON audit record: why the trade opened (trigger, side selection, fill). */
  explanation?: string | null
}): number {
  const info = prep(
    getDb(),
    `INSERT INTO trades
        (market_id, slot_end_ms, side, price, shares, cost, result, pnl, balance_after, dust_saved, mode,
         status, order_id, trade_uid, entry_at_ms, mark_price, unrealized_pnl, explanation)
       VALUES (?, ?, ?, ?, ?, ?, 'OPEN', 0, ?, 0, ?, 'OPEN', ?, ?, ?, ?, 0, ?)`,
  ).run(
    t.marketId,
    t.slotEndMs,
    t.side,
    t.price,
    t.shares,
    t.cost,
    t.balanceAfter,
    t.mode,
    t.orderId ?? null,
    t.tradeUid ?? null,
    Date.now(),
    t.price,
    t.explanation ?? null,
  )
  return Number(info.lastInsertRowid)
}

/** Update the live mark + unrealized PnL on an OPEN trade row. */
export function updateOpenTradeMark(id: number, markPrice: number, unrealizedPnl: number) {
  try {
    prep(getDb(), `UPDATE trades SET mark_price = ?, unrealized_pnl = ? WHERE id = ? AND status = 'OPEN'`).run(
      markPrice,
      unrealizedPnl,
      id,
    )
  } catch {
    /* live-mark updates must never crash the trading loop */
  }
}

/** Merge a new explanation JSON fragment into an existing one (new keys win). */
function mergeExplanations(prev: string | null, next: string): string {
  if (!prev) return next
  try {
    const a = JSON.parse(prev) as Record<string, unknown>
    const b = JSON.parse(next) as Record<string, unknown>
    return JSON.stringify({ ...a, ...b })
  } catch {
    return next
  }
}

/**
 * Finalize an OPEN trade row into its settled result + realized PnL.
 * DB-LEVEL IDEMPOTENCY: `AND status = 'OPEN'` guarantees a row can only ever
 * be settled ONCE — a second settle attempt (early-resolution + rollover race,
 * or any future code path) can never overwrite a committed WIN/LOSS/SCRATCH.
 * Returns the number of rows updated (0 = the row was already settled).
 */
export function settleTrade(t: {
  id: number
  result: "WIN" | "LOSS" | "SCRATCH"
  pnl: number
  balanceAfter: number
  markPrice: number
  /** JSON audit fragment: settlement source, result reason, PnL math. */
  explanation?: string | null
}): number {
  const d = getDb()
  let explanation: string | null = null
  if (t.explanation) {
    const prev = (prep(d, `SELECT explanation FROM trades WHERE id = ?`).get(t.id) as { explanation: string | null } | undefined)
      ?.explanation ?? null
    explanation = mergeExplanations(prev, t.explanation)
  }
  const info = prep(
    d,
    `UPDATE trades
         SET status = 'SETTLED', result = ?, pnl = ?, balance_after = ?, mark_price = ?, unrealized_pnl = NULL,
             settled_at = datetime('now'), explanation = COALESCE(?, explanation)
       WHERE id = ? AND status = 'OPEN'`,
  ).run(t.result, t.pnl, t.balanceAfter, t.markPrice, explanation, t.id)
  return Number(info.changes ?? 0)
}

/**
 * Stamp the post-settlement balance on an already-settled row. Used because
 * the settle → credit sequence commits the row BEFORE the bankroll credit is
 * applied (the row's OPEN status is the idempotency authority), so the final
 * balance is only known immediately after. Display-only field.
 */
export function updateSettledBalance(id: number, balanceAfter: number) {
  prep(getDb(), `UPDATE trades SET balance_after = ? WHERE id = ? AND status = 'SETTLED'`).run(balanceAfter, id)
}

/**
 * On server startup, any row still OPEN means the server restarted while a
 * position was live. The in-memory position pointer is gone so the slot can
 * never be settled normally. Mark these as SCRATCH so they don't stay OPEN
 * forever in the ledger.  Called once from getDb() after migrations.
 */
export function closeOrphanedOpenTrades() {
  try {
    // Same refund-aware path as the boot-time close: a SCRATCH must always
    // return the debited entry cost to the mode's bankroll.
    scratchOrphanedOpenRows(getDb())
  } catch {
    /* never crash startup */
  }
}

export function recentTrades(mode: PipelineMode, limit = 200): SettledTrade[] {
  const rows = prep(
    getDb(),
    `SELECT id, market_id, slot_end_ms, side, price, shares, cost, result, pnl, balance_after, dust_saved, mode,
              created_at, settled_at, status, order_id, trade_uid, entry_at_ms, mark_price, unrealized_pnl, explanation
       FROM trades WHERE mode = ? ORDER BY id DESC LIMIT ?`,
  ).all(mode, limit) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as number,
    marketId: r.market_id as string,
    slotEndMs: r.slot_end_ms as number,
    side: r.side as TradeSide,
    price: r.price as number,
    shares: r.shares as number,
    cost: r.cost as number,
    result: r.result as SettledTrade["result"],
    pnl: r.pnl as number,
    balanceAfter: r.balance_after as number,
    dustSaved: r.dust_saved as number,
    mode: r.mode as PipelineMode,
    createdAt: r.created_at as string,
    settledAt: r.settled_at as string,
    status: (r.status as SettledTrade["status"]) ?? "SETTLED",
    orderId: (r.order_id as string | null) ?? null,
    tradeUid: (r.trade_uid as string | null) ?? null,
    entryAtMs: (r.entry_at_ms as number | null) ?? null,
    markPrice: (r.mark_price as number | null) ?? null,
    unrealizedPnl: (r.unrealized_pnl as number | null) ?? null,
    explanation: (r.explanation as string | null) ?? null,
  }))
}

export type OrderLogEvent = "SUBMITTED" | "REPLACED" | "CANCELLED" | "FILLED" | "SETTLED" | "ERROR" | "WITHHELD" | "REPAIRED"

/** Append-only audit trail of the full order lifecycle for reconciliation. */
export function insertOrderLog(entry: {
  mode: PipelineMode
  event: OrderLogEvent
  marketId: string
  tokenId?: string | null
  exchangeOrderId?: string | null
  side?: TradeSide | null
  price?: number | null
  shares?: number | null
  phase?: string | null
  detail?: string | null
}): void {
  const ts = Date.now()
  queueWrite(() => {
    try {
      prep(
        getDb(),
        `INSERT INTO order_log (ts_ms, mode, event, market_id, token_id, exchange_order_id, side, price, shares, phase, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ts,
        entry.mode,
        entry.event,
        entry.marketId,
        entry.tokenId ?? null,
        entry.exchangeOrderId ?? null,
        entry.side ?? null,
        entry.price ?? null,
        entry.shares ?? null,
        entry.phase ?? null,
        entry.detail ?? null,
      )
    } catch {
      // audit logging must never crash the trading loop
    }
  })
}

export function recentOrderLogs(mode: PipelineMode, limit = 100): Array<Record<string, unknown>> {
  // Explicit projection avoids pulling unused columns over the wire on every
  // dashboard poll (was `SELECT *`).
  return prep(
    getDb(),
    `SELECT id, ts_ms, mode, event, market_id, token_id, exchange_order_id, side, price, shares, phase, detail
       FROM order_log WHERE mode = ? ORDER BY id DESC LIMIT ?`,
  ).all(mode, limit) as Array<Record<string, unknown>>
}

/**
 * Wipe all trade + order-log history for a pipeline mode. Used by the
 * "reset ledger" control action to clear paper-trading history and PnL so
 * the operator can start a clean session. Only affects the given mode.
 */
export function clearLedger(mode: PipelineMode): number {
  const db = getDb()
  const info = db.prepare(`DELETE FROM trades WHERE mode = ?`).run(mode)
  db.prepare(`DELETE FROM order_log WHERE mode = ?`).run(mode)
  return Number(info.changes ?? 0)
}

/**
 * Periodic DB maintenance for months-long unattended operation:
 *  • prune order_log rows older than `retainDays` (it grows on every order
 *    event and would otherwise expand unboundedly; trades are NEVER pruned —
 *    they are the permanent ledger)
 *  • truncate-checkpoint the WAL so the -wal file cannot grow without bound
 * Returns a summary string for logging.
 */
export function runDbMaintenance(retainDays = 30): string {
  const d = getDb()
  const cutoffMs = Date.now() - retainDays * 86_400_000
  const pruned = d.prepare(`DELETE FROM order_log WHERE ts_ms < ?`).run(cutoffMs).changes
  const prunedAudit = pruneAuditLog(retainDays)
  const wal = d.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>
  const walInfo = wal?.[0] ? `wal log=${wal[0].log} checkpointed=${wal[0].checkpointed}` : "wal n/a"
  // Automated daily backup rides the same daily maintenance cycle: a
  // consistent VACUUM INTO snapshot with 7-day retention. Best-effort —
  // a backup failure must never abort ledger pruning.
  let backupInfo = ""
  try {
    backupInfo = `; backup ${backupDatabase(7)}`
  } catch (e) {
    backupInfo = `; backup FAILED: ${(e as Error).message}`
  }
  return `pruned ${pruned} order_log + ${prunedAudit} audit rows older than ${retainDays}d; ${walInfo}${backupInfo}`
}

/**
 * Realized PnL and settled-trade count for the current UTC day. Used by the
 * risk manager's daily-loss circuit breaker. `settled_at` is stored by
 * SQLite's datetime('now') which is UTC, so date('now') compares correctly.
 */
export function dailyRiskStats(mode: PipelineMode): { realizedPnl: number; settledTrades: number } {
  // settled_at >= date('now') is a sargable range predicate that uses
  // idx_trades_mode_settled; date(settled_at) = date('now') would not.
  // (settled_at is 'YYYY-MM-DD HH:MM:SS' UTC, so the string comparison
  // against 'YYYY-MM-DD' matches exactly the current UTC day.)
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS pnl, COUNT(*) AS n
       FROM trades
       WHERE mode = ? AND result NOT IN ('OPEN') AND settled_at >= date('now')`,
    )
    .get(mode) as { pnl: number; n: number }
  return { realizedPnl: row.pnl ?? 0, settledTrades: row.n ?? 0 }
}

/** Orders submitted today (UTC) for a mode — the daily submission-rate cap. */
export function dailyOrderSubmissions(mode: PipelineMode): number {
  const startOfUtcDayMs = new Date(new Date().toISOString().slice(0, 10)).getTime()
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM order_log WHERE mode = ? AND event = 'SUBMITTED' AND ts_ms >= ?`)
    .get(mode, startOfUtcDayMs) as { n: number }
  return row.n ?? 0
}

export function tradeStats(mode: PipelineMode): { totalPnl: number; wins: number; losses: number } {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS total,
              SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN result = 'LOSS' THEN 1 ELSE 0 END) AS losses
       FROM trades WHERE mode = ?`,
    )
    .get(mode) as { total: number; wins: number | null; losses: number | null }
  return { totalPnl: row.total ?? 0, wins: row.wins ?? 0, losses: row.losses ?? 0 }
}

/**
 * Aggregate lifecycle metrics for the Intelligence Feed summary footer.
 * Combines the trades ledger (fills, positions, realized/unrealized PnL)
 * with the order_log audit trail (submissions) for the given pipeline mode.
 */
export function feedStats(mode: PipelineMode): {
  ordersSubmitted: number
  ordersFilled: number
  totalShares: number
  openPositions: number
  closedPositions: number
  wins: number
  losses: number
  realizedPnl: number
  unrealizedPnl: number
} {
  const db = getDb()
  const t = db
    .prepare(
      `SELECT COUNT(*) AS filled,
              COALESCE(SUM(shares), 0) AS shares,
              SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN status = 'SETTLED' THEN 1 ELSE 0 END) AS closed,
              SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN result = 'LOSS' THEN 1 ELSE 0 END) AS losses,
              COALESCE(SUM(CASE WHEN status = 'SETTLED' THEN pnl ELSE 0 END), 0) AS realized,
              COALESCE(SUM(CASE WHEN status = 'OPEN' THEN unrealized_pnl ELSE 0 END), 0) AS unrealized
       FROM trades WHERE mode = ?`,
    )
    .get(mode) as {
    filled: number
    shares: number
    open: number | null
    closed: number | null
    wins: number | null
    losses: number | null
    realized: number
    unrealized: number
  }
  const submitted = db
    .prepare(`SELECT COUNT(*) AS n FROM order_log WHERE mode = ? AND event = 'SUBMITTED'`)
    .get(mode) as { n: number }

  // Orders submitted should never read below the number that actually filled.
  const ordersFilled = t.filled ?? 0
  const ordersSubmitted = Math.max(submitted.n ?? 0, ordersFilled)

  return {
    ordersSubmitted,
    ordersFilled,
    totalShares: t.shares ?? 0,
    openPositions: t.open ?? 0,
    closedPositions: t.closed ?? 0,
    wins: t.wins ?? 0,
    losses: t.losses ?? 0,
    realizedPnl: Math.round((t.realized ?? 0) * 100) / 100,
    unrealizedPnl: Math.round((t.unrealized ?? 0) * 100) / 100,
  }
}

// ------------------------------------------------------------
// Structured audit log (persisted; the in-memory event ring in
// events.ts remains the fast path for the live dashboard feed).
// ------------------------------------------------------------

export interface AuditRow {
  id: number
  tsMs: number
  level: string
  category: string
  message: string
}

/** Append an audit entry. Must never crash any caller — writes are queued
 *  off the trading loop so warn/error events never fsync-block the caller. */
export function insertAuditLog(level: string, category: string, message: string) {
  const ts = Date.now()
  queueWrite(() => {
    try {
      prep(getDb(), `INSERT INTO audit_log (ts_ms, level, category, message) VALUES (?, ?, ?, ?)`).run(ts, level, category, message)
    } catch {
      /* audit persistence is best-effort */
    }
  })
}

/** Filter + full-text search over the audit log (newest first). */
export function queryAuditLog(opts: {
  category?: string | null
  level?: string | null
  search?: string | null
  sinceMs?: number | null
  limit?: number
}): AuditRow[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.category) { clauses.push("category = ?"); params.push(opts.category) }
  if (opts.level) { clauses.push("level = ?"); params.push(opts.level) }
  if (opts.search) { clauses.push("message LIKE ?"); params.push(`%${opts.search}%`) }
  if (opts.sinceMs) { clauses.push("ts_ms >= ?"); params.push(opts.sinceMs) }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000)
  const rows = getDb()
    .prepare(`SELECT id, ts_ms, level, category, message FROM audit_log ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as Array<{ id: number; ts_ms: number; level: string; category: string; message: string }>
  return rows.map((r) => ({ id: r.id, tsMs: r.ts_ms, level: r.level, category: r.category, message: r.message }))
}

/** Distinct categories present in the audit log (for the filter dropdown). */
export function auditCategories(): string[] {
  const rows = getDb().prepare(`SELECT DISTINCT category FROM audit_log ORDER BY category`).all() as Array<{ category: string }>
  return rows.map((r) => r.category)
}

/** Prune audit rows older than retainDays. Called from db maintenance. */
export function pruneAuditLog(retainDays = 30): number {
  const cutoff = Date.now() - retainDays * 86_400_000
  return Number(getDb().prepare(`DELETE FROM audit_log WHERE ts_ms < ?`).run(cutoff).changes ?? 0)
}

// ------------------------------------------------------------
// Database administration: stats, integrity, backups.
// ------------------------------------------------------------

export interface DbStats {
  fileSizeBytes: number
  walSizeBytes: number
  tradeCount: number
  orderLogCount: number
  auditLogCount: number
  kvCount: number
  integrityOk: boolean | null
  lastBackupAt: string | null
  backups: Array<{ name: string; sizeBytes: number; mtimeMs: number }>
}

function dbFilePath(): string {
  return path.resolve(process.cwd(), env.DB_PATH)
}

function backupDir(): string {
  const dir = path.join(path.dirname(dbFilePath()), "backups")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Full database statistics for the dashboard. Integrity check is optional (costly). */
export function dbStats(runIntegrityCheck = false): DbStats {
  const d = getDb()
  const count = (table: string) => Number((d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n ?? 0)
  let fileSizeBytes = 0
  let walSizeBytes = 0
  try { fileSizeBytes = fs.statSync(dbFilePath()).size } catch { /* absent until first write */ }
  try { walSizeBytes = fs.statSync(`${dbFilePath()}-wal`).size } catch { /* no wal file */ }
  let integrityOk: boolean | null = null
  if (runIntegrityCheck) {
    try {
      const res = d.pragma("integrity_check") as Array<{ integrity_check: string }>
      integrityOk = res?.[0]?.integrity_check === "ok"
    } catch { integrityOk = false }
  }
  let backups: DbStats["backups"] = []
  try {
    backups = fs.readdirSync(backupDir())
      .filter((f) => f.endsWith(".db"))
      .map((f) => { const s = fs.statSync(path.join(backupDir(), f)); return { name: f, sizeBytes: s.size, mtimeMs: s.mtimeMs } })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch { /* backup dir unreadable */ }
  return {
    fileSizeBytes,
    walSizeBytes,
    tradeCount: count("trades"),
    orderLogCount: count("order_log"),
    auditLogCount: count("audit_log"),
    kvCount: count("kv"),
    integrityOk,
    lastBackupAt: backups[0] ? new Date(backups[0].mtimeMs).toISOString() : null,
    backups: backups.slice(0, 14),
  }
}

/**
 * Consistent online backup via SQLite's VACUUM INTO (safe under WAL — takes a
 * transactional snapshot without blocking writers). Keeps the newest
 * `retain` backups, prunes older ones. Returns the backup file name.
 */
export function backupDatabase(retain = 7): string {
  const stamp = new Date().toISOString().slice(0, 10)
  const file = path.join(backupDir(), `edge5-${stamp}.db`)
  // Overwrite same-day backups (VACUUM INTO refuses existing targets).
  try { fs.unlinkSync(file) } catch { /* no same-day backup */ }
  getDb().prepare(`VACUUM INTO ?`).run(file)
  // Prune beyond retention (oldest first).
  try {
    const all = fs.readdirSync(backupDir())
      .filter((f) => f.endsWith(".db"))
      .map((f) => ({ f, m: fs.statSync(path.join(backupDir(), f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    for (const old of all.slice(retain)) fs.unlinkSync(path.join(backupDir(), old.f))
  } catch { /* retention pruning is best-effort */ }
  return path.basename(file)
}

/** PRAGMA integrity_check (full). Returns "ok" or the failure detail. */
export function integrityCheck(): string {
  try {
    const res = getDb().pragma("integrity_check") as Array<{ integrity_check: string }>
    return res?.[0]?.integrity_check ?? "unknown"
  } catch (e) {
    return `check failed: ${(e as Error).message}`
  }
}

/** All settled + open trades for a mode as export rows (oldest first, no limit). */
export function exportTrades(mode: PipelineMode): Array<Record<string, unknown>> {
  return getDb()
    .prepare(`SELECT * FROM trades WHERE mode = ? ORDER BY id ASC`)
    .all(mode) as Array<Record<string, unknown>>
}

// ------------------------------------------------------------
// Persistent execution-latency samples (see latency_samples table).
// One row per submitted standing limit order. Writes are queued through
// queueWrite so the trading hot path is never blocked.
// ------------------------------------------------------------

export interface LatencySampleInsert {
  mode: PipelineMode
  marketId: string
  exchangeOrderId: string | null
  side: TradeSide | null
  shares: number | null
  limitPrice: number | null
  quoteAgeMs: number
  decisionMs: number
  preSubmitMs: number
  submitMs: number
  fillCheckMs: number
  totalMs: number
  submitAtMs: number
}

export interface LatencySampleRow {
  id: number
  ts_ms: number
  mode: string
  market_id: string
  exchange_order_id: string | null
  side: string | null
  shares: number | null
  limit_price: number | null
  quote_age_ms: number
  decision_ms: number
  pre_submit_ms: number
  submit_ms: number
  fill_check_ms: number
  total_ms: number
  submit_at_ms: number
  fill_observed_ms: number | null
  filled_price: number | null
}

export function insertLatencySample(s: LatencySampleInsert): void {
  queueWrite(() => {
    prep(
      getDb(),
      `INSERT INTO latency_samples
         (ts_ms, mode, market_id, exchange_order_id, side, shares, limit_price,
          quote_age_ms, decision_ms, pre_submit_ms, submit_ms, fill_check_ms,
          total_ms, submit_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Date.now(),
      s.mode,
      s.marketId,
      s.exchangeOrderId,
      s.side,
      s.shares,
      s.limitPrice,
      Math.round(s.quoteAgeMs),
      Math.round(s.decisionMs),
      Math.round(s.preSubmitMs),
      Math.round(s.submitMs),
      Math.round(s.fillCheckMs),
      Math.round(s.totalMs),
      Math.round(s.submitAtMs),
    )
  })
}

/** Record the observed fill time (ms since publish/submit) for the sample
 *  keyed by exchange order id. No-op if we never persisted a sample for it. */
export function recordLatencyFillObserved(
  exchangeOrderId: string | null | undefined,
  filledPrice: number,
  filledAtMs: number,
): void {
  if (!exchangeOrderId) return
  queueWrite(() => {
    prep(
      getDb(),
      `UPDATE latency_samples
         SET fill_observed_ms = MAX(0, ? - submit_at_ms),
             filled_price = ?
       WHERE exchange_order_id = ? AND fill_observed_ms IS NULL`,
    ).run(Math.round(filledAtMs), filledPrice, exchangeOrderId)
  })
}

export function getLatencySamples(mode: PipelineMode, limit = 50): LatencySampleRow[] {
  return prep(
    getDb(),
    `SELECT * FROM latency_samples WHERE mode = ? ORDER BY id DESC LIMIT ?`,
  ).all(mode, Math.max(1, Math.min(500, limit))) as LatencySampleRow[]
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

export interface LatencyPhaseStat {
  count: number
  avg: number
  p50: number
  p95: number
  max: number
}

export interface LatencyReport {
  mode: PipelineMode
  windowMs: number
  windowStartMs: number
  sampleCount: number
  filledCount: number
  phases: {
    quoteAge: LatencyPhaseStat
    decision: LatencyPhaseStat
    preSubmit: LatencyPhaseStat
    submit: LatencyPhaseStat
    fillCheck: LatencyPhaseStat
    total: LatencyPhaseStat
    fillObserved: LatencyPhaseStat
  }
}

/** Aggregate percentile stats over the last `windowMs` for a given mode. */
export function getLatencyReport(mode: PipelineMode, windowMs = 24 * 60 * 60 * 1000): LatencyReport {
  const windowStartMs = Date.now() - windowMs
  const rows = prep(
    getDb(),
    `SELECT quote_age_ms, decision_ms, pre_submit_ms, submit_ms, fill_check_ms,
            total_ms, fill_observed_ms
       FROM latency_samples
       WHERE mode = ? AND ts_ms >= ?`,
  ).all(mode, windowStartMs) as Array<{
    quote_age_ms: number
    decision_ms: number
    pre_submit_ms: number
    submit_ms: number
    fill_check_ms: number
    total_ms: number
    fill_observed_ms: number | null
  }>

  const stat = (values: number[]): LatencyPhaseStat => {
    if (values.length === 0) return { count: 0, avg: 0, p50: 0, p95: 0, max: 0 }
    const sorted = [...values].sort((a, b) => a - b)
    const sum = sorted.reduce((a, b) => a + b, 0)
    return {
      count: sorted.length,
      avg: Math.round(sum / sorted.length),
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted[sorted.length - 1],
    }
  }

  const filled = rows.filter((r) => r.fill_observed_ms != null).map((r) => r.fill_observed_ms as number)
  return {
    mode,
    windowMs,
    windowStartMs,
    sampleCount: rows.length,
    filledCount: filled.length,
    phases: {
      quoteAge: stat(rows.map((r) => r.quote_age_ms)),
      decision: stat(rows.map((r) => r.decision_ms)),
      preSubmit: stat(rows.map((r) => r.pre_submit_ms)),
      submit: stat(rows.map((r) => r.submit_ms)),
      fillCheck: stat(rows.map((r) => r.fill_check_ms)),
      total: stat(rows.map((r) => r.total_ms)),
      fillObserved: stat(filled),
    },
  }
}
