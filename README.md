# Polymarket 5-Minute BTC Maker-Snipe Engine

A dual-pipeline (V1 Paper / V2 Live) high-frequency **maker** engine for Polymarket's 5-minute Bitcoin Up/Down contracts, built on the CLOB V2 architecture (pUSD collateral, EIP-712 + HMAC L2 auth). Includes a cyberpunk web dashboard, an integrated Telegram control bot, and a local SQLite ledger.

> **Disclaimer:** Trading involves substantial risk. LIVE_V2 mode places real on-chain orders with real capital. Always validate a strategy in PAPER_V1 mode first. Nothing here is financial advice.

---

## System Overview

The engine ships as **two fully isolated pipelines** that run in the same process under separate global singletons: `lib/v1/engine/` (PAPER_V1, simulated) and `lib/v2/engine/` (LIVE_V2, real orders). The trading core is kept byte-for-byte identical between them; only the executor, config, and a handful of live-only feeds differ. The tree below shows `lib/v2/engine/` (V1 mirrors it, minus the live executor and account sync):

```
lib/v2/engine/
├── engine.ts            # Orchestrator: slot lifecycle, tick loop, PnL settlement
├── clock.ts             # Drift-corrected 5-minute slot clock
├── config.ts            # Runtime config (bands, padding, mode) - hot-adjustable
├── db.ts                # SQLite ledger (trades, candles, engine state), mode-namespaced
├── bankroll.ts          # Balance pool; delegates sizing to dust-compounding handler
├── standing-order.ts    # Standing Limit Order manager (DEFAULT engine; CLOB-driven)
├── telegram.ts          # Long-polling Telegram control bot (LIVE_V2 owns it; V1 disabled)
├── events.ts            # In-process event bus feeding the dashboard SSE/API
├── types.ts             # Shared domain types
├── strategy/
│   └── sniper.ts        # Cascading time-decay target matrix (P1/P2/P3 windows)
├── strategy-registry/   # 6-edge quant strategy registry (opt-in; one active at a time)
│   ├── types.ts         # Strategy interface + StrategyMeta + param schema
│   ├── registry.ts      # Factory: id → Strategy, default params, metadata
│   └── strategies/
│       ├── edge1-40-50-sequential.ts     # Sequential match (DOWN $0.50 → UP $0.40)
│       ├── edge2-penny-continuum.ts       # Penny-perfect book tracker ($0.80–$0.99)
│       ├── edge3-passive-trapping.ts      # 6 institutional sub-profiles
│       ├── edge4-context-aware.ts         # Rule manual (strategies C / D / E)
│       ├── edge5-meta-cognitive.ts        # Cascading sniper (wraps sniper.ts)
│       └── edge6-book-depth-alpha.ts      # High-conviction bid-ask wall filter
├── handlers/            # Isolated, pure safety modules (single source of truth)
│   ├── oracle-sync-guard.ts        # Spot-vs-strike padding drift guard
│   ├── cancel-replace-pipeline.ts  # Sub-100ms cancel/replace latency classifier
│   ├── dust-compounding.ts         # floor(pool/price) sizing + fractional dust sweep
│   ├── orphan-cleaner.ts           # Unhedged-leg detection + market FOK counter
│   └── protocol-validator.ts       # 5-share minimum guard + auto-scale
├── feeds/
│   ├── btc-reference-feed.ts       # Chainlink on-chain BTC/USD reference (DISPLAY ONLY)
│   ├── clob-price-feed.ts          # Polymarket CLOB UP/DOWN token price feed
│   ├── clob-ws-client.ts           # Public CLOB market-data WebSocket
│   ├── order-events.ts             # Authenticated CLOB user-channel WS (read-only fills)
│   ├── account-sync.ts             # Live account mirror (CLOB SDK + public Data API)
│   └── market-discovery.ts         # Gamma API slot/market resolver
└── execution/
    ├── executor.ts      # Common executor interface (hot-swap boundary)
    ├── paper.ts         # PAPER_V1: simulated matching engine, zero live keys
    └── live.ts          # LIVE_V2: adapter over @polymarket/clob-client-v2 (official SDK
                         #          handles EIP-712 signing + HMAC L2 auth)
```

> **Two execution models.** The **Standing Limit Order** manager is the default engine and runs standalone (`activeStrategy` defaults to `null`). The 6 strategy **edges** are opt-in: selecting one from the Strategies tab routes it into the tick loop. The drift guard and sniper matrix only trade when an edge is active.

### Strategy Registry: 6 Quant Edges

The engine routes exactly **one** edge into the active pipeline at a time (selectable from the Strategies tab or via Telegram). Each edge exposes typed, numeric parameters — no sliders.

| ID | Name | Core behavior |
|---|---|---|
| `edge1` | 40/50 Sequential Match | Rests DOWN @ $0.50; on fill instantly fires UP @ $0.40 |
| `edge2` | Penny Continuum | Fires a limit FOK maker the instant a token hits a user-defined cent |
| `edge3` | Passive Trapping | 6 institutional sub-profiles (arb, latency, imbalance, endcycle…) |
| `edge4` | Context-Aware Manual | Rule C (Δ divergence), D (volume spike), E (T-3s buffered sniper) |
| `edge5` | Meta-Cognitive Sniper | Early-candle reversal freeze + cascading P1/P2/P3 matrix |
| `edge6` | Book-Depth Alpha | Blocks entry unless bid-ask wall ratio > 2× + external alpha |

### Edge 5 — The Cascading Sniper (final 20s of each candle)

| Window | Time | Target band | Behavior |
|---|---|---|---|
| Priority 1 | T-20s → T-11s | $0.90 – $0.94 | Hunt cheap liquidity, max margin |
| Priority 2 | T-10s → T-3s | $0.95 – $0.99 | Directional-certainty escalation |
| Priority 3 | T-2s → T-0s | — | **HOLD / STOPPING** — all orders dropped, firing forbidden |

Both bands are adjustable live from the dashboard's numeric Target Grid (with step arrows — no sliders) without restarting the engine.

### Core Safeguards (`lib/v2/engine/handlers/`)

Each safeguard is an isolated, pure, independently testable module that the engine and strategies import as the single source of truth.

- **Oracle Sync Drift Guard** (`oracle-sync-guard.ts`) — when a strategy edge is active, its orders are cross-checked against the Chainlink BTC reference; if spot has not cleared the strike by the padding margin (default `$12`, `driftPaddingUsd`), the trade is aborted. Note: the default Standing Limit Order path is CLOB-driven and does not consume this guard.
- **Sub-100ms Cancel/Replace** (`cancel-replace-pipeline.ts`) — spot reversals against a resting order trigger an immediate cancel-and-replace cycle; latency is classified against the budget.
- **Orphan Asset Cleaner** (`orphan-cleaner.ts`) — if a hedge leg fails, the lone position is flattened with an immediate market-priced FOK counter, resetting exposure to zero.
- **5-Share Protocol Guard** (`protocol-validator.ts`) — allocations auto-scale up to clear Polymarket's 5-share order floor.
- **Compounding + Dust Sweep** (`dust-compounding.ts`) — `shares = floor(pool / price)`; fractional remainder is banked as dust and rolled into the next candle's capital pool.

---

## Requirements

- Linux VPS (Ubuntu 22.04+ recommended), 1 vCPU / 1 GB RAM minimum
- Node.js 20+ and pnpm (`npm i -g pnpm`)
- PM2 (`npm i -g pm2`)
- Low-latency region recommended (US-East) for Polymarket CLOB + Polygon RPC round-trips

## Installation

```bash
git clone <your-repo-url> polybot && cd polybot
pnpm install
cp .env.example .env    # then fill in your values
pnpm build
```

## Environment Variables (`.env`)

Variable names below are the **canonical** ones read by `lib/*/engine/config.ts`. Legacy `POLY_*` aliases (shown in parentheses) still work as fallbacks. See `.env.example` for the complete, authoritative list.

| Variable | Pipeline | Description |
|---|---|---|
| `ENVIRONMENT` | both | `PAPER_V1` (default, safe) or `LIVE_V2` |
| `PAPER_STARTING_BALANCE` | V1 | Simulated starting bankroll in USD (default `100`) |
| `WALLET_PRIVATE_KEY` (`POLY_PRIVATE_KEY`) | V2 | Level-1 signing wallet private key. **Never commit.** |
| `FUNDER_ADDRESS` (`POLY_PROXY_ADDRESS`) | V2 | Proxy/funder address that holds USDC |
| `CLOB_API_KEY` (`POLY_API_KEY`) | V2 | CLOB L2 API key |
| `CLOB_SECRET` (`POLY_API_SECRET`) | V2 | CLOB L2 HMAC secret |
| `CLOB_PASS_PHRASE` (`POLY_API_PASSPHRASE`) | V2 | CLOB L2 passphrase |
| `SIGNATURE_TYPE` | V2 | `0`=EOA, `1`=proxy (default), `2`=Gnosis Safe |
| `POLYMARKET_CLOB_URL` | V2 | CLOB REST endpoint (default `https://clob.polymarket.com`) |
| `CLOB_WS_HOST` | V2 | CLOB WebSocket endpoint |
| `DATA_API_HOST` | V2 | Public Data API for account positions/value (default `https://data-api.polymarket.com`) |
| `BTC_REFERENCE_SOURCE` | both | `chainlink-onchain` (default) or `chainlink-datastreams` |
| `CHAINLINK_RPC_URL` | both | Comma-separated Polygon RPC(s) for the on-chain BTC/USD aggregator |
| `TELEGRAM_BOT_TOKEN` | V2 | From `@BotFather` — leave blank to disable Telegram |
| `TELEGRAM_CHAT_ID` | V2 | Your chat/channel ID for control + PnL cards |
| `DB_PATH` | both | SQLite ledger path (default `data/edge5.db`) |

To obtain L2 credentials, derive them once with your wallet key via the official SDK's `createOrDeriveApiKey()` — the `@polymarket/clob-client-v2` client performs the EIP-712 L1 signature and thereafter authenticates with HMAC L2 headers. The engine does not hand-roll any signing.

## Telegram Setup

> The Telegram control bot is owned exclusively by the **LIVE_V2** engine. Because Telegram permits only one long-poll consumer per bot token and both pipelines can run at once, the V1 paper engine does not attach to Telegram.

1. Message `@BotFather`, create a bot, copy the token into `TELEGRAM_BOT_TOKEN`.
2. Message your bot once, then get your chat ID (e.g. via `@userinfobot`) into `TELEGRAM_CHAT_ID`.
3. Commands: `/start_bot`, `/stop_bot`, `/set_balance <amount>`, `/status`, `/strategies`, `/set_strategy <edgeN>`.
4. After every settled trade the bot pushes a PnL card: market, side, fill price, result, net PnL, compounded bankroll, dust reserve.

## Running with PM2 (production daemon)

```bash
pnpm build
pm2 start ecosystem.config.js
pm2 save                 # persist across reboots
pm2 startup              # generate boot script (follow printed command)
```

Useful commands:

```bash
pm2 status               # process health
pm2 logs polybot         # tail engine + dashboard logs
pm2 restart polybot      # zero-hassle restart
pm2 stop polybot         # halt everything
```

The dashboard is then available at `http://<vps-ip>:3000`. Front it with nginx + TLS and restrict access (basic auth or firewall) — the control API starts/stops the engine.

## Dashboard (4-Tab Cyberpunk HUD)

All tabs stay mounted — switching never interrupts the countdown, WebSocket tickers, or SWR polling.

- **Tab 1 — Operation Deck** — V1/V2 pipeline hot-swap, ignition start / emergency-stop, paper funding box, and the numeric Target Grid (Priority 1 / Priority 2 floor & ceiling as text fields with step arrows). Applied live, no restart.
- **Tab 2 — Strategy Configurator** — all 6 registry edges as cards; activate one and fine-tune its typed parameters (numeric / toggle / select).
- **Tab 3 — Signal Tank** — millisecond drift-corrected candle countdown, UP/DOWN token boxes with electric-border flashes on target-zone entry, and the active edge's intelligence feed.
- **Tab 4 — Compounding Ledger** — Market ID → Side → Shares → Compounded Capital → Dust Saved → Net PnL, with a running dust-reserve counter.

## Going Live Checklist

1. Run PAPER_V1 for a meaningful sample of candles; review the ledger win rate and drawdown.
2. Fund the Polymarket proxy wallet with pUSD.
3. Set `ENVIRONMENT=LIVE_V2` and all V2 credentials in `.env`.
4. `pm2 restart polybot` and start with a small bankroll.

## Troubleshooting: Engine Goes "Cold" (LIVE_V2 Market Discovery)

In **LIVE_V2 mode**, the engine displays `marketDiscovery: "waiting"` when:

1. **Market not yet published**: Polymarket (via Gamma API) only lists markets once they're active or have closed. Future-slot markets won't exist in the API until close-of-slot.
   - **Expected behavior**: The status shows `marketDiscovery: "waiting"` with a `liveMarket: null`. This is normal during the inter-candle gap.
   - **Fix**: Wait for the next slot to open, or check that your current slot exists: `curl https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-<slot-end-epoch>`.

2. **Gamma API unreachable**: The HTTP fetch times out after 5s.
   - **Fix**: Check your VPS network (firewall rules, geolocation). Gamma is hosted in the US; if you're blocked by ISP, use a proxy or switch regions.

3. **Live credentials incomplete**: LIVE_V2 start will refuse and log an error if any of `WALLET_PRIVATE_KEY`, `FUNDER_ADDRESS`, `CLOB_API_KEY`, `CLOB_SECRET`, `CLOB_PASS_PHRASE` are missing (legacy `POLY_*` aliases also accepted).
   - **Check**: `curl http://localhost:3000/api/v2/bot/status | jq '.liveKeysLoaded'` (should be `true`).

**Dashboard Health Signal**: Check the status endpoint's `marketDiscovery` field:
- `null` → PAPER_V1 mode (no market discovery needed)
- `"waiting"` → Actively polling Gamma for the current slot's market
- `"ready"` → Market resolved and loaded into the engine; ready to fire

---

## Safety Notes

- `.env` is fully git-ignored; only `.env.example` is committed.
- The engine never fires payloads inside the final 2 seconds of a candle (Priority 3 hold state).
- All live orders are strictly limit **maker** orders — 0% taker fees, rebate-eligible.
- SQLite state lives in `data/` (also git-ignored); back it up if you care about the ledger history.
