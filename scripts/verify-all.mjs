#!/usr/bin/env node
/**
 * Full-system verification harness (READ-ONLY — never places orders).
 *
 * Exercises every subsystem the engine depends on, using the real
 * credentials in .env:
 *   env vars → wallet → CLOB L1/L2 auth → market discovery →
 *   orderbook (bid/ask/mid/last/liquidity) → WebSocket → Chainlink →
 *   clock sync → SQLite DB.
 *
 * Usage:  node --env-file=.env scripts/verify-all.mjs
 *    or:  pnpm verify
 */

import { Wallet } from "ethers"
import { ClobClient, AssetType, COLLATERAL_TOKEN_DECIMALS } from "@polymarket/clob-client-v2"
import Database from "better-sqlite3"
import WebSocket from "ws"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

const results = []
const ok = (name, detail) => results.push({ name, status: "PASS", detail })
const warn = (name, detail) => results.push({ name, status: "WARN", detail })
const fail = (name, detail) => results.push({ name, status: "FAIL", detail })

const SLOT_MS = 5 * 60 * 1000
const CLOB = process.env.POLYMARKET_CLOB_URL || process.env.CLOB_HTTP_HOST || "https://clob.polymarket.com"
const GAMMA = process.env.GAMMA_HTTP_HOST || "https://gamma-api.polymarket.com"
const DATA_API = process.env.DATA_API_HOST || "https://data-api.polymarket.com"
const WS_HOST = process.env.CLOB_WS_HOST || "wss://ws-subscriptions-clob.polymarket.com/ws"

function timed(url, init) {
  return fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(12_000) })
}

// ---------- 1. Environment variables ----------
function checkEnv() {
  const required = [
    "ENVIRONMENT",
    "WALLET_PRIVATE_KEY",
    "FUNDER_ADDRESS",
    "CLOB_API_KEY",
    "CLOB_SECRET",
    "CLOB_PASS_PHRASE",
  ]
  const missing = required.filter((k) => !process.env[k])
  if (missing.length) return fail("Environment variables", `Missing: ${missing.join(", ")}`)
  const mode = process.env.ENVIRONMENT
  if (mode !== "PAPER_V1" && mode !== "LIVE_V2")
    return fail("Environment variables", `ENVIRONMENT must be PAPER_V1 or LIVE_V2, got "${mode}"`)
  ok("Environment variables", `All required vars set, ENVIRONMENT=${mode}`)
}

// ---------- 2. Wallet initialization ----------
function checkWallet() {
  try {
    const w = new Wallet(process.env.WALLET_PRIVATE_KEY)
    ok("Wallet initialization", `Signer address ${w.address}`)
    return w
  } catch (e) {
    fail("Wallet initialization", `Invalid WALLET_PRIVATE_KEY: ${e.message}`)
    return null
  }
}

// ---------- 3. CLOB client + auth ----------
class Adapter {
  constructor(w) {
    this.w = w
  }
  _signTypedData(d, t, v) {
    return this.w.signTypedData(d, t, v)
  }
  getAddress() {
    return Promise.resolve(this.w.address)
  }
}

function buildClient(wallet) {
  try {
    const client = new ClobClient({
      host: CLOB,
      chain: Number(process.env.CHAIN_ID || 137),
      signer: new Adapter(wallet),
      creds: {
        key: process.env.CLOB_API_KEY,
        secret: process.env.CLOB_SECRET,
        passphrase: process.env.CLOB_PASS_PHRASE,
      },
      signatureType: Number(process.env.SIGNATURE_TYPE ?? 1),
      funderAddress: process.env.FUNDER_ADDRESS,
      useServerTime: true,
    })
    ok("SDK initialization", "@polymarket/clob-client-v2 ClobClient constructed")
    return client
  } catch (e) {
    fail("SDK initialization", e.message)
    return null
  }
}

async function checkRest() {
  try {
    const r = await timed(`${CLOB}/ok`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    ok("REST API connectivity", `${CLOB}/ok → ${r.status}`)
  } catch (e) {
    fail("REST API connectivity", `${CLOB}/ok unreachable: ${e.message}`)
  }
}

async function checkClock() {
  try {
    const t0 = Date.now()
    const r = await timed(`${CLOB}/time`)
    const serverSec = Number(await r.text())
    const rtt = Date.now() - t0
    const offset = serverSec * 1000 + rtt / 2 - Date.now()
    if (Math.abs(offset) > 2000) warn("Clock sync", `Offset vs CLOB server ${Math.round(offset)}ms (>2s)`)
    else ok("Clock sync", `Offset vs CLOB server ${Math.round(offset)}ms (rtt ${rtt}ms)`)
  } catch (e) {
    fail("Clock sync", e.message)
  }
}

async function checkClobAuth(client) {
  // L2 (HMAC) auth: authenticated read of collateral balance.
  try {
    const r = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
    const usd = Number(r?.balance ?? 0) / 10 ** COLLATERAL_TOKEN_DECIMALS
    ok("CLOB L2 auth (HMAC)", `getBalanceAllowance OK — collateral $${usd.toFixed(2)} USDC`)
    return true
  } catch (e) {
    fail("CLOB L2 auth (HMAC)", `getBalanceAllowance rejected: ${e?.message ?? e}`)
    return false
  }
}

async function checkOpenOrdersAndTrades(client) {
  try {
    const orders = await client.getOpenOrders(undefined, true)
    ok("Account open orders", `${Array.isArray(orders) ? orders.length : 0} resting order(s)`)
  } catch (e) {
    fail("Account open orders", e?.message ?? String(e))
  }
  try {
    const trades = await client.getTrades(undefined, true)
    ok("Account trade history", `${Array.isArray(trades) ? trades.length : 0} recent trade(s) readable`)
  } catch (e) {
    fail("Account trade history", e?.message ?? String(e))
  }
}

async function checkDataApi() {
  try {
    const addr = process.env.FUNDER_ADDRESS
    const r = await timed(`${DATA_API}/positions?user=${addr}&limit=5`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const rows = await r.json()
    ok("Data API (positions)", `${Array.isArray(rows) ? rows.length : 0} position row(s) for funder`)
  } catch (e) {
    warn("Data API (positions)", e.message)
  }
}

// ---------- 4. Market discovery ----------
function slugForSlot(slotEndMs) {
  return `btc-updown-5m-${Math.round((slotEndMs - SLOT_MS) / 1000)}`
}

async function discoverMarket() {
  const now = Date.now()
  const currentSlotEnd = Math.ceil(now / SLOT_MS) * SLOT_MS
  const slug = slugForSlot(currentSlotEnd)
  try {
    const r = await timed(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const list = await r.json()
    if (!list.length || !list[0].conditionId || !list[0].clobTokenIds) {
      fail("BTC 5m market discovery", `Gamma has no listing for ${slug}`)
      return null
    }
    const m = list[0]
    const tokenIds = JSON.parse(m.clobTokenIds)
    const outcomes = m.outcomes ? JSON.parse(m.outcomes) : ["Up", "Down"]
    const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up")
    const remaining = ((currentSlotEnd - now) / 1000).toFixed(0)
    ok(
      "BTC 5m market discovery",
      `${slug} live (cond ${m.conditionId.slice(0, 10)}…, active=${m.active}) — ${remaining}s remaining in window`,
    )
    ok("Remaining market time", `${remaining}s until slot close (slot end ${new Date(currentSlotEnd).toISOString()})`)
    return { slug, upTokenId: tokenIds[upIdx >= 0 ? upIdx : 0], downTokenId: tokenIds[upIdx >= 0 ? 1 - upIdx : 1] }
  } catch (e) {
    fail("BTC 5m market discovery", `${slug}: ${e.message}`)
    return null
  }
}

// ---------- 5. Orderbook ----------
async function checkOrderbook(tokenId) {
  try {
    const r = await timed(`${CLOB}/book?token_id=${tokenId}`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const book = await r.json()
    const bids = (book.bids ?? []).map((l) => ({ p: Number(l.price), s: Number(l.size) }))
    const asks = (book.asks ?? []).map((l) => ({ p: Number(l.price), s: Number(l.size) }))
    const bestBid = bids.length ? Math.max(...bids.map((b) => b.p)) : null
    const bestAsk = asks.length ? Math.min(...asks.map((a) => a.p)) : null
    const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null
    const bidLiq = bids.reduce((t, b) => t + b.p * b.s, 0)
    const askLiq = asks.reduce((t, a) => t + a.p * a.s, 0)
    if (bestBid === null || bestAsk === null) {
      warn("Orderbook (UP token)", "Book fetched but one side is empty (thin market moment)")
    } else {
      ok(
        "Orderbook (UP token)",
        `bestBid ${bestBid.toFixed(2)} / bestAsk ${bestAsk.toFixed(2)} / mid ${mid.toFixed(3)} — liquidity $${(bidLiq + askLiq).toFixed(0)} (${bids.length} bid lvls, ${asks.length} ask lvls)`,
      )
    }
  } catch (e) {
    fail("Orderbook (UP token)", e.message)
  }
  try {
    const r = await timed(`${CLOB}/last-trade-price?token_id=${tokenId}`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const lt = await r.json()
    ok("Last trade price", `${lt.price} (side ${lt.side ?? "?"})`)
  } catch (e) {
    warn("Last trade price", e.message)
  }
}

// ---------- 6. WebSocket ----------
function checkWebSocket(tokenId) {
  return new Promise((resolve) => {
    const url = `${WS_HOST.replace(/\/$/, "")}/market`
    const sock = new WebSocket(url)
    const timer = setTimeout(() => {
      fail("WebSocket connectivity", `No book message within 15s from ${url}`)
      try {
        sock.terminate()
      } catch {}
      resolve()
    }, 15_000)
    sock.on("open", () => {
      sock.send(JSON.stringify({ assets_ids: [tokenId], type: "market" }))
    })
    sock.on("message", (raw) => {
      try {
        const msgs = JSON.parse(raw.toString())
        const arr = Array.isArray(msgs) ? msgs : [msgs]
        const book = arr.find((m) => m.event_type === "book" || m.event_type === "price_change")
        if (book) {
          clearTimeout(timer)
          ok("WebSocket connectivity", `${url} → live "${book.event_type}" event for market stream`)
          sock.close()
          resolve()
        }
      } catch {}
    })
    sock.on("error", (e) => {
      clearTimeout(timer)
      fail("WebSocket connectivity", `${url}: ${e.message}`)
      resolve()
    })
  })
}

// ---------- 7. Chainlink BTC reference ----------
async function checkChainlink() {
  const feeds = (process.env.CHAINLINK_RPC_URL || "https://polygon-bor-rpc.publicnode.com")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean)
  const aggregator = process.env.CHAINLINK_BTC_USD_FEED || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  for (const rpc of feeds) {
    try {
      const r = await timed(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: aggregator, data: "0xfeaf968c" }, "latest"],
        }),
      })
      const data = await r.json()
      if (data.result && data.result.length >= 2 + 128) {
        const price = Number(BigInt("0x" + data.result.slice(2 + 64, 2 + 128))) / 1e8
        if (price > 0) {
          ok("Chainlink BTC reference", `BTC/USD $${price.toFixed(2)} via ${new URL(rpc).host}`)
          return
        }
      }
    } catch {
      /* next RPC */
    }
  }
  warn("Chainlink BTC reference", "All RPCs failed (display-only feed; does not block trading)")
}

// ---------- 8. Database ----------
function checkDb() {
  try {
    const path = process.env.DB_PATH || "data/edge5.db"
    mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path)
    db.pragma("journal_mode = WAL")
    db.exec("CREATE TABLE IF NOT EXISTS _verify_probe (id INTEGER PRIMARY KEY, ts INTEGER)")
    db.prepare("INSERT INTO _verify_probe (ts) VALUES (?)").run(Date.now())
    const row = db.prepare("SELECT COUNT(*) AS n FROM _verify_probe").get()
    db.exec("DROP TABLE _verify_probe")
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    db.close()
    ok("Database (better-sqlite3)", `${path} writable (probe rows ${row.n}); tables: ${tables.map((t) => t.name).join(", ") || "none yet"}`)
  } catch (e) {
    fail("Database (better-sqlite3)", e.message)
  }
}

// ---------- main ----------
async function main() {
  console.log("── BTC 5M full-system verification (read-only) ──\n")

  checkEnv()
  const wallet = checkWallet()
  checkDb()
  await Promise.all([checkRest(), checkClock(), checkChainlink(), checkDataApi()])

  let client = null
  if (wallet) client = buildClient(wallet)
  if (client) {
    const authed = await checkClobAuth(client)
    if (authed) await checkOpenOrdersAndTrades(client)
  }

  const market = await discoverMarket()
  if (market) {
    await checkOrderbook(market.upTokenId)
    await checkWebSocket(market.upTokenId)
  }

  // ---------- report ----------
  console.log("")
  const pad = (s, n) => s.padEnd(n)
  for (const r of results) {
    const icon = r.status === "PASS" ? "✓" : r.status === "WARN" ? "!" : "✗"
    console.log(`${icon} ${pad(`[${r.status}]`, 7)} ${pad(r.name, 28)} ${r.detail}`)
  }
  const fails = results.filter((r) => r.status === "FAIL").length
  const warns = results.filter((r) => r.status === "WARN").length
  console.log(`\n${results.length} checks — ${results.length - fails - warns} pass, ${warns} warn, ${fails} fail`)
  process.exit(fails > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error("verification harness crashed:", e)
  process.exit(1)
})
