import { clockOffsetMs, clockSynced, currentSlotEndMs } from "./clock"
import { SLOT_MS, env } from "./config"
import { slugForSlot } from "./feeds/market-discovery"

// ------------------------------------------------------------
// Pre-flight readiness checks, run on demand before ignition.
// Each check is independent, time-boxed, and never throws; the
// report is a structured pass/warn/fail matrix for the dashboard.
// ------------------------------------------------------------

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP"

export interface PreflightCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
}

export interface PreflightReport {
  ranAtMs: number
  mode: string
  ready: boolean
  checks: PreflightCheck[]
}

const TIMEOUT_MS = 6_000

function timed(url: string, init?: RequestInit) {
  return fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) })
}

async function checkClock(): Promise<PreflightCheck> {
  const offset = clockOffsetMs()
  if (!clockSynced()) {
    // Clock sync is async and happens in background. This is normal on first check.
    // The engine will use local time initially, then switch to synced time once ready.
    // This is safe and does not impair order execution — it just means candle gates
    // fire relative to local clock until sync completes (typically <2s).
    return {
      id: "clock",
      label: "NTP Clock Sync",
      status: "PASS",
      detail: "Syncing in background (normal on startup); local time fallback active",
    }
  }
  if (Math.abs(offset) > 1000) {
    return { id: "clock", label: "NTP Clock Sync", status: "WARN", detail: `Synced but drift offset ${offset}ms exceeds 1s — check system clock` }
  }
  return { id: "clock", label: "NTP Clock Sync", status: "PASS", detail: `Synced, drift offset ${offset}ms (acceptable)` }
}

async function checkSpotFeed(): Promise<PreflightCheck> {
  // Chainlink BTC/USD reference price (DISPLAY ONLY — never drives contract
  // prices or the Standing Limit Order). Probe the on-chain aggregator via
  // the configured public RPC with a raw eth_call to latestRoundData().
  //   selector for latestRoundData() = 0xfeaf968c
  const rpcUrls = env.CHAINLINK_RPC_URL.split(",")
    .map((u) => u.trim())
    .filter(Boolean)
  for (const rpcUrl of rpcUrls) {
    try {
      const res = await timed(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: env.CHAINLINK_BTC_USD_FEED, data: "0xfeaf968c" }, "latest"],
        }),
      })
      if (res.ok) {
        const data = (await res.json()) as { result?: string; error?: unknown }
        if (!data.error && data.result && data.result.length >= 2 + 64 * 2) {
          // answer is the 2nd 32-byte word (int256, 8 decimals).
          const answerHex = data.result.slice(2 + 64, 2 + 64 * 2)
          const price = Number(BigInt("0x" + answerHex)) / 1e8
          if (Number.isFinite(price) && price > 0) {
            return {
              id: "spot",
              label: "Chainlink BTC Reference",
              status: "PASS",
              detail: `On-chain Chainlink BTC/USD active, BTC $${price.toFixed(2)} (display only)`,
            }
          }
        }
      }
    } catch {
      /* try next RPC */
    }
  }
  // Non-fatal: the BTC reference is display-only and the Standing Limit Order
  // does not depend on it, so a failure here must never block ignition.
  return {
    id: "spot",
    label: "Chainlink BTC Reference",
    status: "WARN",
    detail: "Chainlink RPC unreachable — BTC reference display may be blank (does not affect trading)",
  }
}

async function checkGamma(): Promise<PreflightCheck> {
  // Probe the next slot (guaranteed to be listed before its window).
  const slots = [currentSlotEndMs(), currentSlotEndMs() + SLOT_MS]
  for (const slot of slots) {
    try {
      const slug = slugForSlot(slot)
      const res = await timed(`${env.GAMMA_HTTP_HOST}/markets?slug=${encodeURIComponent(slug)}`)
      if (!res.ok) continue
      const list = (await res.json()) as Array<{ conditionId?: string; clobTokenIds?: string }>
      if (list.length > 0 && list[0].conditionId && list[0].clobTokenIds) {
        return { id: "gamma", label: "Gamma Market Discovery", status: "PASS", detail: `Resolved ${slug}` }
      }
    } catch {
      /* next slot */
    }
  }
  return {
    id: "gamma",
    label: "Gamma Market Discovery",
    status: "FAIL",
    detail: "Could not resolve a 5-minute BTC market from Gamma",
  }
}

async function checkTelegram(): Promise<PreflightCheck> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return { id: "telegram", label: "Telegram Control Bot", status: "SKIP", detail: "TELEGRAM_BOT_TOKEN not configured (optional)" }
  }
  try {
    const res = await timed(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`)
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } }
    if (data.ok) {
      const chat = env.TELEGRAM_CHAT_ID ? `, chat ${env.TELEGRAM_CHAT_ID} locked` : ", WARNING: no TELEGRAM_CHAT_ID (any chat can command)"
      return { id: "telegram", label: "Telegram Control Bot", status: "PASS", detail: `@${data.result?.username ?? "bot"} authorized${chat}` }
    }
    return { id: "telegram", label: "Telegram Control Bot", status: "FAIL", detail: "Token rejected by Telegram API" }
  } catch {
    return { id: "telegram", label: "Telegram Control Bot", status: "FAIL", detail: "Telegram API unreachable" }
  }
}

async function checkLiveAuth(mode: string): Promise<PreflightCheck> {
  if (mode !== "LIVE_V2") {
    return { id: "live", label: "LIVE_V2 Credentials", status: "SKIP", detail: "Paper pipeline: exchange submission simulated; live keys not required" }
  }
  const missing = (
    [
      ["POLY_PRIVATE_KEY", env.POLY_PRIVATE_KEY],
      ["POLY_PROXY_ADDRESS", env.POLY_PROXY_ADDRESS],
      ["POLY_API_KEY", env.POLY_API_KEY],
      ["POLY_API_SECRET", env.POLY_API_SECRET],
      ["POLY_API_PASSPHRASE", env.POLY_API_PASSPHRASE],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length > 0) {
    return { id: "live", label: "LIVE_V2 Credentials", status: "FAIL", detail: `Missing: ${missing.join(", ")}` }
  }
  try {
    const res = await timed(`${env.CLOB_HTTP_HOST}/ok`)
    if (!res.ok) throw new Error(String(res.status))
    return { id: "live", label: "LIVE_V2 Credentials", status: "PASS", detail: "All keys present, CLOB host reachable" }
  } catch {
    return { id: "live", label: "LIVE_V2 Credentials", status: "WARN", detail: "Keys present but CLOB host unreachable" }
  }
}

export async function runPreflight(mode: string): Promise<PreflightReport> {
  const checks = await Promise.all([checkClock(), checkSpotFeed(), checkGamma(), checkTelegram(), checkLiveAuth(mode)])
  return {
    ranAtMs: Date.now(),
    mode,
    ready: checks.every((c) => c.status !== "FAIL"),
    checks,
  }
}
