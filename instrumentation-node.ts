/**
 * Node-only half of the instrumentation hook. This file is loaded via a
 * dynamic import from instrumentation.ts ONLY when NEXT_RUNTIME === "nodejs",
 * which keeps Node APIs (process.on, process.uptime, memoryUsage) out of the
 * Edge Runtime bundle — the edge bundler statically analyzes everything that
 * instrumentation.ts imports directly.
 *
 * Installs last-resort crash diagnostics for unattended VPS operation:
 *
 *  • unhandledRejection — logged with a full structured stack and the process
 *    KEPT ALIVE. Every engine path already has local try/catch; a stray
 *    rejection from a fire-and-forget promise must not kill a trading
 *    process that is otherwise healthy.
 *  • uncaughtException — logged with full diagnostics, then the process exits
 *    (state may be corrupt; PM2 restarts it and the engine's auto-resume +
 *    kv/ledger recovery paths restore a safe state). A 2s grace period lets
 *    the log lines flush to PM2's log files.
 *  • SIGTERM/SIGINT — graceful shutdown: dispose the engine (cancels timers,
 *    closes sockets, stops feeds) before exit so PM2 `kill_timeout` is never
 *    hit and no socket lingers half-open.
 */
export function installCrashHandlers() {
  const g = globalThis as { __edge5CrashHandlersInstalled?: boolean }
  if (g.__edge5CrashHandlersInstalled) return
  g.__edge5CrashHandlersInstalled = true

  const stamp = () => new Date().toISOString()

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    console.error(
      `[${stamp()}] [CRASH-DIAG] UNHANDLED REJECTION (process kept alive): ${err.message}\n${err.stack ?? "(no stack)"}`,
    )
  })

  process.on("uncaughtException", (err) => {
    const mem = process.memoryUsage()
    console.error(
      `[${stamp()}] [CRASH-DIAG] UNCAUGHT EXCEPTION — exiting for PM2 restart: ${err.message}\n` +
        `${err.stack ?? "(no stack)"}\n` +
        `[CRASH-DIAG] pid=${process.pid} uptime=${Math.round(process.uptime())}s ` +
        `rss=${Math.round(mem.rss / 1048576)}MB heap=${Math.round(mem.heapUsed / 1048576)}MB`,
    )
    // Give stdout/stderr 2s to flush into PM2's log files, then exit non-zero.
    setTimeout(() => process.exit(1), 2_000)
  })

  let shuttingDown = false
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[${stamp()}] [SHUTDOWN] ${signal} received — disposing engine (timers, sockets, feeds)`)
    try {
      // Only dispose if the singleton already exists — never boot the engine
      // graph just to tear it down. The engine stores itself under this key.
      const g2 = globalThis as { __botEngineV2?: { dispose: () => void } }
      if (g2.__botEngineV2) {
        g2.__botEngineV2.dispose()
      }
    } catch (e) {
      console.error(`[SHUTDOWN] dispose failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    console.log(`[${stamp()}] [SHUTDOWN] complete — exiting`)
    setTimeout(() => process.exit(0), 500)
  }

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"))
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"))
}
