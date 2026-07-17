import { ProxyAgent, EnvHttpProxyAgent, Socks5ProxyAgent, setGlobalDispatcher } from "undici"
import { HttpsProxyAgent } from "https-proxy-agent"
import WebSocket from "ws"

// ------------------------------------------------------------
// Transparent proxy support for environments where Polymarket
// domains are blocked (e.g. India).
//
// Option A — Set in your .env (explicit):
//   HTTPS_PROXY=http://user:pass@your-vps-ip:3128
//   SOCKS5_PROXY=socks5://user:pass@your-vps-ip:1080
//
// Option B — SSH tunnel (easiest, no extra software):
//   1. In a separate terminal: ssh -D 1080 -N user@your-vps-ip
//   2. Add to .env:           SOCKS5_PROXY=socks5://127.0.0.1:1080
//
// Option C — System-level proxy (Windows VPN / proxy settings):
//   If your OS has HTTPS_PROXY set as a system environment variable,
//   it will be picked up automatically with no .env change needed.
//
// When no proxy is configured the engine connects directly (correct
// behaviour on a VPS or any unrestricted network).
// ------------------------------------------------------------

const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || ""
const SOCKS5_PROXY = process.env.SOCKS5_PROXY || process.env.socks5_proxy || ""

export const PROXY_URL = SOCKS5_PROXY || HTTPS_PROXY || ""

/**
 * Call once at engine startup. Patches the global Node.js fetch dispatcher
 * so every fetch() in the process routes through the proxy.
 *
 * Priority:
 *  1. SOCKS5_PROXY / HTTPS_PROXY in .env  → explicit ProxyAgent / Socks5ProxyAgent
 *  2. System HTTPS_PROXY / HTTP_PROXY env vars → undici EnvHttpProxyAgent (auto)
 *  3. No proxy → direct connection
 */
export function applyGlobalProxyPatch(): void {
  if (PROXY_URL) {
    try {
      const dispatcher = PROXY_URL.startsWith("socks")
        ? new Socks5ProxyAgent(PROXY_URL)
        : new ProxyAgent(PROXY_URL)
      setGlobalDispatcher(dispatcher as Parameters<typeof setGlobalDispatcher>[0])
      console.log(`[proxy] global fetch patched (explicit) → ${PROXY_URL.replace(/:\/\/[^@]+@/, "://<redacted>@")}`)
    } catch (e) {
      console.warn(`[proxy] explicit proxy failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    return
  }
  // Auto-detect system proxy via EnvHttpProxyAgent (reads HTTPS_PROXY, HTTP_PROXY, NO_PROXY)
  const systemProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || ""
  if (systemProxy) {
    try {
      setGlobalDispatcher(new EnvHttpProxyAgent())
      console.log(`[proxy] global fetch patched (system env) → ${systemProxy.replace(/:\/\/[^@]+@/, "://<redacted>@")}`)
    } catch (e) {
      console.warn(`[proxy] system env proxy failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/**
 * Returns a ws-compatible agent for WebSocket connections routed through the proxy.
 */
export function getWsAgent(): import("http").Agent | undefined {
  if (!PROXY_URL) return undefined
  try {
    // SOCKS proxies: use https-proxy-agent (ws package supports this natively)
    // HTTP/HTTPS proxies: use HttpsProxyAgent (CONNECT tunnel)
    return new HttpsProxyAgent(PROXY_URL) as unknown as import("http").Agent
  } catch (e) {
    console.warn(`[proxy] failed to create WS agent: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
}

/**
 * Proxy-aware WebSocket factory. Drop-in replacement for `new WebSocket(url)`.
 */
export function createProxiedWebSocket(url: string): WebSocket {
  const agent = getWsAgent()
  if (agent) {
    return new WebSocket(url, { agent })
  }
  return new WebSocket(url)
}
