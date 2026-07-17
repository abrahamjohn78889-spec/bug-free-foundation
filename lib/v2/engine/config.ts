import type { StrategyConfig, PipelineMode, StrategyId, StrategyParams } from "./types"

// ------------------------------------------------------------
// Static environment configuration (.env vault)
// ------------------------------------------------------------

export const env = {
  // Pipeline selector: PAPER_V1 (default, zero risk, full testing) or LIVE_V2
  // Paper trading is ALWAYS the safe default for testing all strategies and features
  ENVIRONMENT: (process.env.ENVIRONMENT as PipelineMode) || "PAPER_V1",

  // --- Live V2 credentials (only read when ENVIRONMENT=LIVE_V2) ---
  // Each credential accepts the blueprint's canonical name FIRST, then falls
  // back to the legacy POLY_* name, so existing vaults keep working while new
  // deployments can use the documented names.
  //   WALLET_PRIVATE_KEY  ← POLY_PRIVATE_KEY   (Level 1 signing wallet)
  //   FUNDER_ADDRESS      ← POLY_PROXY_ADDRESS (proxy/funder that holds USDC)
  //   CLOB_API_KEY        ← POLY_API_KEY       (Level 2 HMAC)
  //   CLOB_SECRET         ← POLY_API_SECRET
  //   CLOB_PASS_PHRASE    ← POLY_API_PASSPHRASE
  POLY_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || process.env.POLY_PRIVATE_KEY || "",
  POLY_PROXY_ADDRESS: process.env.FUNDER_ADDRESS || process.env.POLY_PROXY_ADDRESS || "",
  POLY_API_KEY: process.env.CLOB_API_KEY || process.env.POLY_API_KEY || "",
  POLY_API_SECRET: process.env.CLOB_SECRET || process.env.POLY_API_SECRET || "",
  POLY_API_PASSPHRASE: process.env.CLOB_PASS_PHRASE || process.env.POLY_API_PASSPHRASE || "",
  // Polymarket signature type: 0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE. Default
  // 1 (proxy wallet) matches the FUNDER_ADDRESS flow.
  SIGNATURE_TYPE: Number(process.env.SIGNATURE_TYPE ?? 1),

  // --- Endpoints (overridable so the suite tracks CLOB V2 rollouts) ---
  CLOB_HTTP_HOST: process.env.POLYMARKET_CLOB_URL || process.env.CLOB_HTTP_HOST || "https://clob.polymarket.com",
  CLOB_WS_HOST: process.env.CLOB_WS_HOST || "wss://ws-subscriptions-clob.polymarket.com/ws",
  GAMMA_HTTP_HOST: process.env.GAMMA_HTTP_HOST || "https://gamma-api.polymarket.com",
  // Official public Data API — positions, portfolio value, and PnL keyed by
  // wallet address (no auth). Used only to mirror the account on the dashboard.
  DATA_API_HOST: process.env.DATA_API_HOST || "https://data-api.polymarket.com",
  CHAIN_ID: Number(process.env.POLYMARKET_CHAIN_ID || process.env.CHAIN_ID || 137),
  EXCHANGE_CONTRACT: process.env.EXCHANGE_CONTRACT || "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",

  // --- BTC reference price feed (DISPLAY ONLY) ---
  // The Bitcoin reference price is sourced from Chainlink and shown separately
  // from the Polymarket contract prices. It NEVER derives UP/DOWN contract
  // values and the Standing Limit Order never depends on it.
  //   • chainlink-onchain    — reads the on-chain Chainlink BTC/USD aggregator
  //                            via a public RPC (default, no credentials).
  //   • chainlink-datastreams — future low-latency Data Streams API (needs keys).
  BTC_REFERENCE_SOURCE:
    (process.env.BTC_REFERENCE_SOURCE as "chainlink-onchain" | "chainlink-datastreams") || "chainlink-onchain",
  // Public Polygon RPC(s) for reading the on-chain Chainlink aggregator.
  // Comma-separated list; the feed rotates to the next on failure.
  CHAINLINK_RPC_URL:
    process.env.CHAINLINK_RPC_URL ||
    "https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org,https://1rpc.io/matic",
  // Chainlink BTC/USD price feed aggregator (Polygon mainnet).
  CHAINLINK_BTC_USD_FEED: process.env.CHAINLINK_BTC_USD_FEED || "0xc907E116054Ad103354f2D350FD2514433D57F6f",
  // Placeholders for the future Data Streams swap (unused until credentials exist).
  CHAINLINK_DATASTREAMS_API_KEY: process.env.CHAINLINK_DATASTREAMS_API_KEY || "",
  CHAINLINK_DATASTREAMS_API_SECRET: process.env.CHAINLINK_DATASTREAMS_API_SECRET || "",

  // --- Telegram ---
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",

  // --- Paper testing ---
  PAPER_STARTING_BALANCE: Number(process.env.PAPER_STARTING_BALANCE || 100),

  // --- Storage ---
  DB_PATH: process.env.DB_PATH || "data/edge5.db",
}

// ------------------------------------------------------------
// Runtime strategy configuration (adjustable via dashboard
// sliders and Telegram without restarting the process)
// ------------------------------------------------------------

export const DEFAULT_STRATEGY: StrategyConfig = {
  p1Band: { min: 0.9, max: 0.94 },
  p2Band: { min: 0.95, max: 0.99 },
  driftPaddingUsd: 12, // spot must clear strike by $12 before firing
  minShares: 5, // Polymarket hard minimum
  cancelReplaceBudgetMs: 100, // sub-100ms mandate
  tif: "GTC", // default: rest until STOPPING clears it
  priceFloor: 0.75, // never place or fill below $0.75
  priceCeil: 0.99, // never place or fill above $0.99
  activeStrategy: null, // no strategy active by default; Standing Limit Order can run standalone
  p1WindowMs: 20_000, // T-20s window (milliseconds); set to 0 to disable
  // Per-edge params are seeded from the registry in the engine
  // constructor to avoid a config → registry → sniper → config cycle.
  strategyParams: {} as Record<StrategyId, StrategyParams>,
}

/** TIF duration in milliseconds (null = GTC, no expiry timer). */
export const TIF_MS: Record<string, number | null> = {
  "1m": 60_000,
  "2m": 120_000,
  GTC: null,
}

// Candle geometry (5-minute Bitcoin Up/Down contracts)
export const SLOT_MS = 5 * 60 * 1000
export const P1_OPEN_MS = 20_000 // T-20s
export const P2_OPEN_MS = 10_000 // T-10s
export const HOLD_MS = 2_000 // T-2s -> STOPPING, payloads forbidden

export function clampBand(min: number, max: number) {
  const lo = Math.min(Math.max(min, 0.5), 0.99)
  const hi = Math.min(Math.max(max, lo), 0.99)
  return { min: Math.round(lo * 100) / 100, max: Math.round(hi * 100) / 100 }
}
