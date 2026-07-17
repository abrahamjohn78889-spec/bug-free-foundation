/**
 * Per-worker SQLite isolation.
 *
 * Test files run in parallel forked processes (vitest `pool: "forks"`).
 * Several integration suites (settlement, sizing-and-window, soak,
 * standing-order) share engine modules that persist state to the SQLite
 * ledger — including the StandingOrderManager's `slo:state:<mode>` KV key.
 * With a single shared `data/test-ledger.db`, two files running
 * concurrently clobber each other's persisted state, producing flaky
 * failures that never reproduce in isolation.
 *
 * This setup file runs BEFORE each test file is imported, so the engine's
 * config (which reads DB_PATH at import time) picks up a path unique to
 * the current worker fork. Files that set their own DB_PATH afterwards
 * (profiles-and-console, ops-chaos) are unaffected — they override in
 * beforeEach with vi.resetModules().
 */
const poolId = process.env.VITEST_POOL_ID ?? "0"
process.env.DB_PATH = `data/test-ledger-${poolId}.db`
