/**
 * Next.js instrumentation hook — runs ONCE per server process at boot.
 *
 * This entry file is bundled for EVERY runtime (nodejs, edge), so it must not
 * reference Node APIs directly — the edge bundler statically analyzes it and
 * rejects process.on / process.uptime / memoryUsage. All Node-only crash
 * handling lives in instrumentation-node.ts behind a dynamic import that only
 * executes on the nodejs runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { installCrashHandlers } = await import("./instrumentation-node")
  installCrashHandlers()
  // Telegram remote command console: no-ops unless TELEGRAM_BOT_TOKEN and
  // TELEGRAM_CHAT_ID are configured. Fully isolated from the trading path.
  const { startTelegramConsole } = await import("./lib/v2/engine/telegram-console")
  startTelegramConsole()
}
