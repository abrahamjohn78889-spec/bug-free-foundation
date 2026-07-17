# v2 LIVE Trading - Production Setup Guide

## Requirements Checklist

Before deploying v2 LIVE trading to your VPS, ensure you have:

### 1. Valid Polymarket Credentials (Burner Wallet)
- [ ] `WALLET_PRIVATE_KEY` - Your funded burner wallet's private key (starts with `0x`)
- [ ] `FUNDER_ADDRESS` - The same wallet's address (starts with `0x`)
- [ ] `CLOB_API_KEY` - Generated from `gen-creds.js` 
- [ ] `CLOB_SECRET` - Generated from `gen-creds.js`
- [ ] `CLOB_PASS_PHRASE` - Generated from `gen-creds.js`

### 2. VPS Setup
- [ ] VPS in a country where Polymarket is accessible (US, Europe, Singapore, etc.)
- [ ] Node.js 18+ installed (`node --version`)
- [ ] `pnpm` installed (`pnpm --version`)
- [ ] SSH access and ability to run `npm` commands

### 3. Code & Environment
- [ ] Latest ZIP downloaded and extracted to your VPS
- [ ] `.env` file configured with your credentials (see below)
- [ ] No proxy settings needed on VPS (leave `HTTPS_PROXY` and `SOCKS5_PROXY` blank)

## Deployment Steps

### Step 1: Copy Project to VPS
```bash
# On your local machine
scp -r /path/to/polymarket-bot-v2-env-updated-2 user@your-vps-ip:/home/user/
ssh user@your-vps-ip "cd /home/user/polymarket-bot-v2-env-updated-2 && ls -la"
```

### Step 2: Create & Configure .env
```bash
ssh user@your-vps-ip
cd ~/polymarket-bot-v2-env-updated-2
cat > .env << 'EOF'
ENVIRONMENT=LIVE_V2
PAPER_STARTING_BALANCE=100

WALLET_PRIVATE_KEY=0x<your-burner-wallet-private-key>
FUNDER_ADDRESS=0x<your-polymarket-funder-address>

CLOB_API_KEY=<from gen-creds.js>
CLOB_SECRET=<from gen-creds.js>
CLOB_PASS_PHRASE=<from gen-creds.js>
SIGNATURE_TYPE=1

POLYMARKET_CLOB_URL=https://clob.polymarket.com
CLOB_HTTP_HOST=https://clob.polymarket.com
CLOB_WS_HOST=wss://ws-subscriptions-clob.polymarket.com/ws
GAMMA_HTTP_HOST=https://gamma-api.polymarket.com
DATA_API_HOST=https://data-api.polymarket.com
CHAIN_ID=137
EXCHANGE_CONTRACT=0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E

BTC_REFERENCE_SOURCE=chainlink-onchain
CHAINLINK_RPC_URL=https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org,https://1rpc.io/matic
CHAINLINK_BTC_USD_FEED=0xc907E116054Ad103354f2D350FD2514433D57F6f
CHAINLINK_DATASTREAMS_API_KEY=
CHAINLINK_DATASTREAMS_API_SECRET=

DB_PATH=data/edge5.db

HTTPS_PROXY=
SOCKS5_PROXY=

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
EOF
cat .env
```

### Step 3: Install & Run
```bash
pnpm install
npm run dev
# Bot will start on http://localhost:3001
```

### Step 4: Access the Dashboard
Open `http://your-vps-ip:3001` in your browser to see:
- ✅ **SIGNAL TANK** showing LIVE Polymarket prices
- ✅ **MARKET CONTEXT** with the active BTC market
- ✅ **STANDING LIMIT ORDER** with current positions
- ✅ **CLOB FEED DIAGNOSTIC** if there are issues

### Step 5: Start Trading
1. Click **OPS DECK** tab
2. Click the **START** button
3. Monitor the **INTELLIGENCE FEED** for order status
4. Watch **SIGNAL TANK** for live pricing updates

## Production Checks

Before going LIVE, verify:

### In the Dashboard
- [ ] **Signal Tank LIVE badge** shows (not "NO DATA")
- [ ] **CLOB FEED DIAGNOSTIC** shows both UP and DOWN token IDs
- [ ] **MARKET CONTEXT** shows "SYNCED" (not "AWAITING GAMMA")
- [ ] **Chainlink BTC price** displays correctly
- [ ] **START button** is clickable and doesn't show errors
- [ ] **RESTING ORDER** shows your configured limit buy (when armed)

### In the Logs
```bash
# SSH into VPS and check last 20 lines of logs
tail -20 ~/.pm2/logs/npm-dev-error.log
```

Look for:
- ✅ `[v0] CLOB poll — UP token ... ask=...`
- ✅ `[edge5][INFO] CLOB ask — Up: $..., Down: $...`
- ✅ `[edge5][INFO] Chainlink BTC/USD reference: $...`
- ✅ `[v0][clob-ws] connected to market channel`

Look for errors to AVOID:
- ❌ `invalid BytesLike value`
- ❌ `ECONNREFUSED` (network blocked)
- ❌ `Market discovery failed for btc-updown-5m-*` (repeated every 5s with no backoff)

## Troubleshooting

### "NO DATA" in Signal Tank
**Cause**: CLOB prices not loading  
**Fix**: 
1. Check `.env` credentials are correct
2. Verify VPS can reach `clob.polymarket.com` (`curl https://clob.polymarket.com`)
3. Check logs for `CLOB FEED DIAGNOSTIC` section
4. Restart: `npm run dev`

### "START" button disabled / not working
**Cause**: Credentials invalid or engine won't initialize  
**Fix**:
1. Verify `.env` has no template placeholders
2. Ensure `WALLET_PRIVATE_KEY` starts with `0x` and is 66 characters long
3. Check logs for "invalid BytesLike value" or "LIVE_V2 requires..."
4. Regenerate credentials with `gen-creds.js` if needed

### "AWAITING GAMMA" never resolves
**Cause**: Market discovery failing (backoff preventing hammering)  
**Fix**:
1. Verify VPS can reach `gamma-api.polymarket.com`
2. Backoff will auto-retry in 2s → 5s → 10s → 20s → 30s
3. Wait for next 5-minute candle (market may not exist yet)
4. Check logs for "Market resolved: Bitcoin Up or Down..." message

### Slow polling / high latency
**Cause**: Network slowness or VPS in distant region  
**Fix**:
1. Expected: CLOB prices poll every 2s
2. Normal: Polling takes 200-500ms on good connection
3. If >1s, consider VPS closer to your location

## Security Notes

- Store `.env` in a **private**, **non-git** location on your VPS
- **Never commit** `.env` to version control
- Use a **burner wallet** (limited funds) for testing
- Enable **Telegram alerts** (set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`) for production monitoring
- Consider running in a **screen** or **tmux** session for persistence

## Monitoring

For continuous monitoring, use `pm2`:
```bash
npm install -g pm2
pm2 start "npm run dev" --name "polymarket-v2" --watch
pm2 monit
pm2 logs
```

---

**v2 LIVE trading is production-ready.** Deploy to your VPS and monitor via the dashboard at `http://your-vps-ip:3001`.
