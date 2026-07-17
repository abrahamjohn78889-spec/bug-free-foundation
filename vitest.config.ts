import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests spin up timers/loops; keep them isolated per file.
    pool: "forks",
    globals: false,
    // Per-worker DB isolation: setup-db.ts assigns each forked worker its own
    // SQLite file (data/test-ledger-<pool>.db) so parallel test files never
    // clobber each other's persisted engine state (e.g. slo:state:* KV keys).
    setupFiles: ["tests/setup-db.ts"],
    // Fallback DB path (overridden per worker by setup-db.ts) and mode. Kept
    // so anything reading env before setup runs still never touches the real
    // data/edge5.db ledger.
    env: {
      DB_PATH: "data/test-ledger.db",
      ENVIRONMENT: "PAPER_V1",
    },
  },
})
