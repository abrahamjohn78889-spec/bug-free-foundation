# Complete Beginner Setup Guide

Everything in this guide is taken directly from the project's actual files.
No generic examples — every command, file name, and variable name is the real one.

---

## 1. Software You Need to Install First

Install these tools on your computer before you touch the project.

### Node.js (JavaScript runtime)

This project requires **Node.js 20 or later** (version 20 is the current LTS
and is what this project targets).

1. Go to https://nodejs.org and download the **LTS** version (green button).
2. Run the installer. Accept all defaults.
3. Open a terminal and verify:

```bash
node --version
# Should print v20.x.x or higher
```

### pnpm (package manager)

This project uses **pnpm**, not npm or yarn. Install it after Node.js:

```bash
npm install -g pnpm
pnpm --version
# Should print 9.x.x or similar
```

### Git (only needed for VPS deployment or cloning)

Download from https://git-scm.com — accept all installer defaults.

```bash
git --version
```

### VS Code (code editor, recommended)

Download from https://code.visualstudio.com.

Recommended extensions (install from the Extensions panel on the left):
- **ESLint** — highlights code problems
- **Prettier** — auto-formats files
- **Tailwind CSS IntelliSense** — autocomplete for styles

---

## 2. Opening the Project in VS Code

1. Open VS Code.
2. Click **File → Open Folder**.
3. Select the project folder (the folder that contains `package.json`).
   - You will see files like `package.json`, `.env.example`, `README.md`,
     `lib/`, `app/`, `tests/`, etc. in the Explorer panel on the left.
4. Open the built-in terminal: **Terminal → New Terminal** (or `` Ctrl+` ``).

### Project structure at a glance

```
project-root/
├── .env.example          ← template for your credentials (copy to .env)
├── .env                  ← YOUR secrets go here (never commit this)
├── package.json          ← all available scripts
├── ecosystem.config.js   ← PM2 config for VPS 24/7 deployment
├── app/
│   ├── api/v1/bot/       ← Paper (V1) API routes
│   └── api/v2/bot/       ← Live (V2) API routes
├── lib/
│   ├── v1/engine/        ← Paper trading engine (PAPER_V1)
│   └── v2/engine/        ← Live trading engine (LIVE_V2)
├── tests/
│   ├── unit/             ← Unit tests (handlers, sniper, model/clock)
│   └── integration/      ← Integration tests (engine loop, settlement)
├── data/                 ← SQLite ledger created automatically (gitignored)
└── logs/                 ← PM2 log files created automatically (gitignored)
```

---

## 3. Environment File and Credentials

### File name and location

The credentials file is called **`.env`** and lives in the **root of the
project** (the same folder as `package.json`).

It does not exist by default. You create it by copying the template:

```bash
# Run this in the project root
cp .env.example .env
```

Then open `.env` in VS Code and fill in the values.

### Every variable explained

```
# ----------------------------------------------------------------
# WHICH PIPELINE TO USE
# ----------------------------------------------------------------
ENVIRONMENT=PAPER_V1
```
- `PAPER_V1` — safe paper trading (simulated, no real money). **Start here.**
- `LIVE_V2` — real orders with real capital. Only change this when you are
  deliberately going live.

---

```
PAPER_STARTING_BALANCE=100
```
Simulated wallet balance in USD for paper trading. Change to any number.

---

```
# ----------------------------------------------------------------
# LIVE V2 CREDENTIALS (only needed when ENVIRONMENT=LIVE_V2)
# ----------------------------------------------------------------
WALLET_PRIVATE_KEY=
```
Your Polygon wallet's **private key** (64 hex characters starting with `0x`).
This is the Level-1 signing key — the one that holds Matic for gas.
- Export it from MetaMask: click the three dots next to your account name →
  Account Details → Export Private Key.
- **NEVER share this with anyone. Never commit `.env` to Git.**

---

```
FUNDER_ADDRESS=
```
The **proxy wallet address** that holds your USDC collateral on Polymarket.
This is your `0x...` wallet address (not the private key — just the address).
- Find it in MetaMask: it's the `0x...` string shown at the top of your account.
- For a basic setup, this is the same wallet as `WALLET_PRIVATE_KEY`.

---

```
CLOB_API_KEY=
CLOB_SECRET=
CLOB_PASS_PHRASE=
```
Level-2 API credentials for the Polymarket CLOB (Central Limit Order Book).
These are NOT the same as your wallet key. You derive them once from your wallet.

How to get them:
1. Go to https://polymarket.com and connect your wallet.
2. Open the browser developer console (F12 → Console).
3. Follow the Polymarket CLOB API key derivation docs at:
   https://docs.polymarket.com/#clob-api-keys
4. The derivation tool (`@polymarket/clob-client-v2`) signs a message with your
   wallet and returns the three values above. Paste them into `.env`.

---

```
SIGNATURE_TYPE=1
```
- `1` = POLY_PROXY (default — use this for a normal Polymarket proxy wallet).
- `0` = EOA (use this if you are signing directly from a raw Ethereum wallet
  without a Polymarket proxy).
- `2` = POLY_GNOSIS_SAFE (Gnosis multi-sig — advanced users only).

---

```
# These are filled in for you — only change if Polymarket updates their URLs.
CLOB_HTTP_HOST=https://clob.polymarket.com
CLOB_WS_HOST=wss://ws-subscriptions-clob.polymarket.com/ws
GAMMA_HTTP_HOST=https://gamma-api.polymarket.com
DATA_API_HOST=https://data-api.polymarket.com
CHAIN_ID=137
EXCHANGE_CONTRACT=0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
```
Leave all of these exactly as they are.

---

```
# BTC reference price (display only — leave these as-is)
BTC_REFERENCE_SOURCE=chainlink-onchain
CHAINLINK_RPC_URL=https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org,https://1rpc.io/matic
CHAINLINK_BTC_USD_FEED=0xc907E116054Ad103354f2D350FD2514433D57F6f
CHAINLINK_DATASTREAMS_API_KEY=
CHAINLINK_DATASTREAMS_API_SECRET=
```
Leave these exactly as they are. The BTC price shown on the dashboard is
display-only — it does not affect any trades.

---

```
# Optional Telegram control bot
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```
If you want Telegram notifications and remote control:
1. Open Telegram and message `@BotFather`.
2. Send `/newbot` and follow the prompts to get a token.
3. Paste the token into `TELEGRAM_BOT_TOKEN`.
4. To get your Chat ID: message `@userinfobot` on Telegram — it will reply with
   your numeric ID. Paste that into `TELEGRAM_CHAT_ID`.

Leave both blank if you do not need Telegram.

---

```
DB_PATH=data/edge5.db
```
The SQLite database file location. The `data/` folder is created automatically
on first run. Leave this as-is.

---

## 4. Terminal Commands (in exact order)

Open the terminal in VS Code (**Terminal → New Terminal**) and run these from
the project root folder.

### Step 1: Install dependencies (run once, or after updating the project)

```bash
pnpm install
```

This downloads all required packages into `node_modules/`. It takes 1–3 minutes
on a fresh machine.

### Step 2: Create your `.env` file (run once)

```bash
cp .env.example .env
```

Then edit `.env` and fill in your credentials as described in Section 3.

### Step 3: Development mode (hot-reload, best for testing locally)

```bash
pnpm dev
```

This starts the dashboard with automatic code reloading. The dashboard will be
available at **http://localhost:3000**.

### Build for production (required before running in production mode)

```bash
pnpm build
```

This compiles and optimises the project. Run this once before deploying to a
VPS, or after any code updates before restarting the production server.

### Production mode (after building)

```bash
pnpm start
```

Runs the optimised build on **port 3000**. This is what PM2 uses on a VPS.

### Type checking

```bash
pnpm exec tsc --noEmit
```

Checks for TypeScript errors without producing any output files. If it prints
nothing, there are no type errors.

### Linting

```bash
pnpm lint
```

Checks the code for style and correctness issues.

### Run tests

```bash
pnpm test
```

Runs all 84 automated tests (unit + integration). They should all pass. No
network access is required — they run entirely in memory.

```bash
pnpm test:watch
```

Runs tests continuously in watch mode, re-running whenever you save a file.
Useful during development.

---

## 5. Dashboard

### URL

```
http://localhost:3000
```

Open this in any web browser after running `pnpm dev` or `pnpm start`.

### How to know it started successfully

- In the terminal, `pnpm dev` will print:
  ```
   ✓ Ready in Xs
   ○ Local: http://localhost:3000
  ```
- The browser will show the trading dashboard (two panels: V1 Paper on the left,
  V2 Live on the right, or a combined view depending on the layout).
- The V1 (Paper) panel should show "IDLE" or "STOPPED" and a paper balance.
- The V2 (Live) panel will show "LIVE_V2 Credentials missing" until you have
  filled in all five live-trading variables in `.env`.

### Which port

**Port 3000** (hard-coded in `ecosystem.config.js` and the default Next.js port).
If port 3000 is already in use on your machine, run `pnpm dev -- -p 3001` to
use a different port, and open `http://localhost:3001` instead.

---

## 6. VPS Deployment (24/7)

This section assumes you have a Linux VPS (Ubuntu 22.04 recommended) with SSH
access.

### Step 1: Connect to your VPS

```bash
ssh your-username@your-server-ip
```

### Step 2: Install Node.js on the VPS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should print v20.x.x
```

### Step 3: Install pnpm on the VPS

```bash
npm install -g pnpm
```

### Step 4: Install PM2 on the VPS

PM2 keeps the bot running after you disconnect from SSH and restarts it if it
crashes.

```bash
npm install -g pm2
```

### Step 5: Upload or clone the project

**Option A: Clone from Git (recommended)**

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git edge5
cd edge5
```

**Option B: Upload via SCP from your local machine** (run this locally, not on VPS)

```bash
scp -r /path/to/project your-username@your-server-ip:~/edge5
```

### Step 6: Install dependencies on the VPS

```bash
cd ~/edge5
pnpm install
```

### Step 7: Create and fill in the `.env` file on the VPS

```bash
cp .env.example .env
nano .env
```

Fill in all the credentials exactly as described in Section 3.
Save with `Ctrl+O`, then `Ctrl+X`.

### Step 8: Build the project

```bash
pnpm build
```

Wait for the build to complete (1–3 minutes). You should see "✓ Compiled
successfully".

### Step 9: Create the logs directory

PM2 writes logs to `logs/` — create it first:

```bash
mkdir -p logs
```

### Step 10: Start with PM2

```bash
pm2 start ecosystem.config.js
```

PM2 will start the app as a daemon named **`edge5`**.

### Step 11: Save PM2 so it survives a server reboot

```bash
pm2 save
pm2 startup
# Follow the one command that pm2 startup prints — copy and run it
```

---

### Viewing logs

```bash
# Live combined output (stdout + stderr)
pm2 logs edge5

# Only errors
pm2 logs edge5 --err

# Full stdout log file
cat logs/edge5.out.log

# Full error log file
cat logs/edge5.err.log
```

Press `Ctrl+C` to stop tailing live logs.

### Checking status

```bash
pm2 status
```

You should see `edge5` with status **online**.

### Restarting after updates

```bash
# Pull the latest code (if using Git)
git pull

# Reinstall dependencies if package.json changed
pnpm install

# Rebuild
pnpm build

# Restart the PM2 process — zero downtime
pm2 restart edge5
```

### Stopping the bot

```bash
pm2 stop edge5
```

### Starting the bot again

```bash
pm2 start edge5
```

### Removing from PM2 entirely

```bash
pm2 delete edge5
```

### Opening the dashboard from VPS

The dashboard is on port 3000 of your server. Access it at:

```
http://YOUR_SERVER_IP:3000
```

If your VPS has a firewall, allow port 3000:

```bash
sudo ufw allow 3000
```

---

## 7. Troubleshooting

### "Cannot find module" or "Module not found"

You have not installed dependencies, or they are incomplete.

```bash
pnpm install
```

### Build fails with TypeScript errors

TypeScript errors are set to non-fatal in `next.config.mjs` (`ignoreBuildErrors: true`),
so a `pnpm build` should still complete. If it fails on something else, run:

```bash
pnpm exec tsc --noEmit
```

Read the errors — they will show you exactly which file and line to fix.

### "Missing environment variables" on startup

The `pnpm dev` or `pnpm start` output will log which variables are missing.
Open `.env` and fill them in. The five variables required for live trading are:

```
WALLET_PRIVATE_KEY
FUNDER_ADDRESS
CLOB_API_KEY
CLOB_SECRET
CLOB_PASS_PHRASE
```

For paper trading only, none of these are required.

### Dashboard not opening / browser shows "This site can't be reached"

1. Make sure `pnpm dev` or `pnpm start` is still running in the terminal.
2. Check the terminal for error messages.
3. Make sure you are opening `http://localhost:3000` (not `https://`).
4. If port 3000 is in use: `pnpm dev -- -p 3001`

### "Port 3000 is already in use"

Something else is using port 3000. Find and kill it:

```bash
# Mac / Linux
lsof -i :3000
kill -9 <PID>

# Or just use a different port
pnpm dev -- -p 3001
```

### Authentication failure (LIVE_V2 credentials rejected)

The V2 preflight check will tell you which credential is wrong. Run the preflight
from the dashboard, or check the API:

```bash
curl http://localhost:3000/api/v2/bot/preflight
```

The response will show which check FAILED. Most common causes:
- Pasted the private key incorrectly (must include `0x` prefix, no spaces).
- API key / secret / passphrase derived from the wrong wallet or copied
  incompletely.
- `SIGNATURE_TYPE` does not match your wallet type (use `1` for a standard
  Polymarket proxy wallet).

### WebSocket shows as disconnected on the dashboard

The CLOB WebSocket connects automatically when the engine is started (click
PLAY on the dashboard). If it stays disconnected:
1. Check that `CLOB_WS_HOST` in `.env` is unchanged from the default.
2. Check that your server can reach `ws-subscriptions-clob.polymarket.com`
   (some VPS providers block outbound WebSocket connections — check your
   firewall rules).

### Engine shows "no market found" or "market discovery failed"

The Gamma API could not resolve the current 5-minute BTC market. This is
usually temporary (Polymarket lists markets a few minutes before each slot).
Wait 1–2 minutes and try again. If it persists, check:

```bash
curl "https://gamma-api.polymarket.com/markets?slug=Will-BTC-be-above-X-at-Y"
```

---

## 8. Final Checklist Before Going Live

Work through this list in order. Do not skip paper trading.

### Before paper trading (V1)

- [ ] Node.js 20+ is installed: `node --version`
- [ ] pnpm is installed: `pnpm --version`
- [ ] Dependencies installed: `pnpm install` (no errors)
- [ ] `.env` file exists in the project root (copied from `.env.example`)
- [ ] `ENVIRONMENT=PAPER_V1` is set in `.env`
- [ ] `PAPER_STARTING_BALANCE=100` (or your desired amount) is set
- [ ] `pnpm dev` starts without errors
- [ ] Dashboard opens at `http://localhost:3000`
- [ ] V1 panel shows paper balance and "IDLE" status
- [ ] Clicking PLAY on the V1 panel starts the paper engine
- [ ] All 84 tests pass: `pnpm test`

### Before live trading (V2)

- [ ] Paper trading has been running without issues
- [ ] All five live credentials are filled in `.env`:
  - [ ] `WALLET_PRIVATE_KEY` — Level 1 signing wallet private key
  - [ ] `FUNDER_ADDRESS` — Proxy wallet address holding USDC
  - [ ] `CLOB_API_KEY` — Level 2 API key
  - [ ] `CLOB_SECRET` — Level 2 HMAC secret
  - [ ] `CLOB_PASS_PHRASE` — Level 2 passphrase
- [ ] `SIGNATURE_TYPE=1` (or `0` for a raw EOA wallet)
- [ ] `ENVIRONMENT=LIVE_V2` is set in `.env`
- [ ] Preflight passes: open the dashboard and click "Run Preflight" on the V2
  panel — all checks must be PASS or WARN (no FAIL)
- [ ] V2 dashboard shows account balance loaded from Polymarket
- [ ] CLOB WebSocket connects after clicking PLAY
- [ ] You understand that clicking PLAY on V2 places **real orders** with real USDC

### For VPS (24/7)

- [ ] `pnpm build` completes with no fatal errors
- [ ] `pm2 start ecosystem.config.js` starts the `edge5` process
- [ ] `pm2 status` shows `edge5` as **online**
- [ ] `pm2 save` and `pm2 startup` have been run so the bot survives reboots
- [ ] Dashboard is accessible at `http://YOUR_SERVER_IP:3000`
- [ ] `pm2 logs edge5` shows no crash loops
