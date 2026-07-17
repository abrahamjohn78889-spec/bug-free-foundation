"use client"

import useSWR from "swr"
import type { EngineSnapshot, SettledTrade } from "@/lib/v2/engine/types"
import type { StrategyMeta } from "@/lib/v2/engine/strategy-registry/types"

/** Session expired mid-use (or auth was just enabled) → go to login. */
function redirectToLogin() {
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`
  }
}

const fetcher = async (url: string) => {
  const r = await fetch(url)
  if (r.status === 401) {
    redirectToLogin()
    throw new Error("Session expired — redirecting to login")
  }
  if (!r.ok) {
    // Surface the server error to SWR instead of caching an error body
    // as if it were a valid EngineSnapshot.
    const body = await r.text().catch(() => "")
    throw new Error(`${url} → HTTP ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}`)
  }
  return r.json()
}

export function useBotStatus() {
  return useSWR<EngineSnapshot>("/api/v2/bot/status", fetcher, {
    refreshInterval: 1000,
    keepPreviousData: true,
    // The 1s poll already keeps data fresh — an extra focus/reconnect
    // revalidation just doubles requests at the exact moment the browser is
    // busiest (tab switch). SWR pauses polling entirely while the tab is
    // hidden (refreshWhenHidden defaults to false), so backgrounded
    // dashboards cost the server nothing.
    revalidateOnFocus: false,
    dedupingInterval: 900,
  })
}

/** Registry metadata is static per build — fetch once, no polling. */
export function useStrategies() {
  return useSWR<{ strategies: StrategyMeta[] }>("/api/v2/bot/strategies", fetcher, {
    revalidateOnFocus: false,
  })
}

/**
 * Settled-trades feed. `active` gates polling: the Ledger is the only
 * consumer, so when its tab is hidden we stop the 2s poll entirely instead
 * of streaming a potentially large trade array nobody is looking at.
 * The cached data stays available for an instant paint on tab return.
 */
export function useTrades(active = true) {
  return useSWR<{ trades: SettledTrade[] }>("/api/v2/bot/trades", fetcher, {
    refreshInterval: active ? 2000 : 0,
    keepPreviousData: true,
    revalidateOnFocus: false,
  })
}

/**
 * Forensic replay bundle for ONE trade. Fetched only when the user expands
 * the replay view (key is null until then); the evidence is immutable once
 * settled, so no polling — cached per trade id.
 */
export function useTradeReplay(tradeId: number | null) {
  return useSWR<{ ok: boolean; replay: import("@/lib/v2/engine/trade-replay").TradeReplayBundle }>(
    tradeId !== null ? `/api/v2/bot/trades/${tradeId}/replay` : null,
    fetcher,
    { revalidateOnFocus: false },
  )
}

/**
 * Analytics summary. Computed server-side from the full ledger; refresh is
 * slow (10s) and gated on tab visibility — analytics are not tick data.
 */
export function useAnalytics(active = true) {
  return useSWR<import("@/lib/v2/engine/analytics").AnalyticsSummary>(
    active ? "/api/v2/bot/analytics" : null,
    fetcher,
    { refreshInterval: active ? 10_000 : 0, keepPreviousData: true, revalidateOnFocus: false },
  )
}

/** System monitoring info (VPS + process + engine health). 5s while visible. */
export function useSystemInfo(active = true) {
  return useSWR<Record<string, unknown>>(active ? "/api/v2/bot/system" : null, fetcher, {
    refreshInterval: active ? 5_000 : 0,
    keepPreviousData: true,
    revalidateOnFocus: false,
  })
}

/** Database stats (sizes, counts, backups). Refreshed on demand + 30s. */
export function useDbStats(active = true) {
  return useSWR<import("@/lib/v2/engine/db").DbStats>(active ? "/api/v2/bot/database" : null, fetcher, {
    refreshInterval: active ? 30_000 : 0,
    keepPreviousData: true,
    revalidateOnFocus: false,
  })
}

/** Notification preferences (category toggles + configured flag). */
export function useNotifyPrefs(active = true) {
  return useSWR<{ prefs: Record<string, boolean>; categories: string[]; configured: boolean }>(
    active ? "/api/v2/bot/notifications" : null,
    fetcher,
    { revalidateOnFocus: false },
  )
}

/** Filterable audit log. Key changes with the filters so SWR caches per-view. */
export function useAuditLog(active: boolean, params: { category?: string; level?: string; search?: string; since?: number }) {
  const qs = new URLSearchParams()
  if (params.category) qs.set("category", params.category)
  if (params.level) qs.set("level", params.level)
  if (params.search) qs.set("search", params.search)
  if (params.since) qs.set("since", String(params.since))
  const key = active ? `/api/v2/bot/audit?${qs.toString()}` : null
  return useSWR<{ rows: Array<{ id: number; tsMs: number; level: string; category: string; message: string }>; categories: string[] }>(
    key,
    fetcher,
    { refreshInterval: active ? 5_000 : 0, keepPreviousData: true, revalidateOnFocus: false },
  )
}

/** Strategy profiles list + which one is active. Refetched on demand via mutate. */
export function useProfiles(active = true) {
  return useSWR<{
    profiles: Array<import("@/lib/v2/engine/strategy-profiles").StrategyProfile>
    activeProfile: string | null
  }>(active ? "/api/v2/bot/profiles" : null, fetcher, { revalidateOnFocus: false })
}

/** Read-only A/B comparison — key includes both names so each pair caches independently. */
export function useComparison(a: string | null, b: string | null) {
  const key = a && b ? `/api/v2/bot/profiles?compare=${encodeURIComponent(a)}&compare_b=${encodeURIComponent(b)}` : null
  return useSWR<import("@/lib/v2/engine/comparison").ComparisonResult>(key, fetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  })
}

export async function sendProfileAction(body: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  const res = await fetch("/api/v2/bot/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (res.status === 401) {
    redirectToLogin()
    return { ok: false, message: "Session expired — redirecting to login" }
  }
  return res.json()
}

export async function sendControl(body: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  const res = await fetch("/api/v2/bot/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (res.status === 401) {
    redirectToLogin()
    return { ok: false, message: "Session expired — redirecting to login" }
  }
  return res.json()
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {})
  if (typeof window !== "undefined") window.location.href = "/login"
}
