import { Agent, setGlobalDispatcher } from "undici"

// ------------------------------------------------------------
// Keep-alive HTTP client reuse.
//
// Node's global `fetch` (undici) pools connections per origin, but the default
// keep-alive timeout is short and idle sockets are closed aggressively. For a
// persistent trading process that hammers a handful of hosts (clob.polymarket,
// gamma-api, the Chainlink RPCs) every ~2s, reopening TLS connections adds
// avoidable latency to every poll and Gamma lookup.
//
// Installing one tuned keep-alive dispatcher for the whole process makes those
// requests reuse warm, already-negotiated TLS sockets. This module is imported
// for its side effect exactly once (guarded by a global flag so the V1 and V2
// stacks in the same process don't fight over the dispatcher).
// ------------------------------------------------------------

const g = globalThis as unknown as { __botKeepAliveInstalled?: boolean }

if (!g.__botKeepAliveInstalled) {
  g.__botKeepAliveInstalled = true
  setGlobalDispatcher(
    new Agent({
      // Keep idle sockets warm well beyond the ~2s poll cadence.
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 120_000,
      // Allow several concurrent in-flight requests per origin (ask+bid+mid+last
      // fire in parallel each poll) without opening a fresh connection each time.
      connections: 32,
      pipelining: 1,
    }),
  )
}

export {}
