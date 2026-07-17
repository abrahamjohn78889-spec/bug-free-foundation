# Operations Runbook — Edge 5 (P4)

Live-money runbook for the V2 engine. Assumes the VPS setup from `PRODUCTION_SETUP.md` (PM2 app name `P4`, port 3000).

## Architecture (safety layers, outermost first)

```
PM2 (ecosystem.config.js)     restart on crash/OOM, exponential backoff, crash-loop guard
 └─ instrumentation.ts        crash records -> logs/crash.log, clean SIGTERM dispose
     └─ Engine (engine.ts)    tick loop, rollover, ledger
         ├─ Watchdog          30s: zombie-WS repair, stale-quote recovery, memory monitor
         ├─ RiskManager       gate on EVERY order: kill switch, daily loss, caps, sanity
         ├─ Reconciler        60s read-only: exchange orders/wallet vs local state
         ├─ StandingOrder     armed config persisted in DB, restored on boot
         └─ Executor (live)   exchange-truth guards on cancel/replace/partial fills
```

State lives in `data/edge5.db` (SQLite WAL). Trades are the permanent ledger and are never pruned; `order_log` is pruned after 30 days by the daily maintenance job.

## Remote dashboard access (desktop + mobile)

Auth is enabled by setting `DASHBOARD_PASSWORD` in `.env`. When set:

- Every page and engine API requires login at `/login` (HMAC-signed HttpOnly `SameSite=Lax` session cookie, 7-day TTL, constant-time password check, 5-failure/30s lockout).
- `/api/v2/bot/health` stays public for uptime monitors (read-only, no secrets).
- Changing `DASHBOARD_PASSWORD` instantly invalidates all existing sessions.
- Logout: LOGOUT button in the dashboard header, or `POST /api/auth/logout`.

To expose the dashboard over HTTPS, use the Nginx template in `deploy/nginx-edge5.conf`
(instructions inside). Key rules: firewall port 3000 (`ufw deny 3000/tcp`), only expose
80/443 via Nginx, and get a real certificate with certbot. The `Secure` cookie flag is
applied automatically when requests arrive via `X-Forwarded-Proto: https`.

All dashboard controls (standing order, risk limits, kill switch, strategy selection,
engine start/stop, bankroll) write to SQLite on the VPS immediately and are restored
after PM2 restart or reboot — nothing is stored only in the browser.

## Daily checks (30 seconds)

```bash
curl -s localhost:3000/api/v2/bot/health | python3 -m json.tool | head -20
pm2 status P4
```

- `status: "healthy"` — nothing to do.
- `"degraded"` — read the failing check's `detail`. The watchdog usually self-heals WS issues within 45s; re-check before intervening.
- `"unhealthy"` — see Recovery below.

## Emergency stop (kill switch)

```bash
# STOP EVERYTHING NOW — blocks all order placement, cancels resting orders, persists across restarts
curl -X POST localhost:3000/api/v2/bot/control -H 'content-type: application/json' \
  -d '{"action":"kill_switch_engage","reason":"manual stop"}'

# Re-enable trading later (standing order stays paused until you resume it)
curl -X POST localhost:3000/api/v2/bot/control -H 'content-type: application/json' \
  -d '{"action":"kill_switch_disengage"}'
```

The daily-loss breaker engages the same switch automatically. Check `risk.killSwitch` in `/api/v2/bot/status`.

## Risk limits (runtime-adjustable, persisted)

```bash
curl -X POST localhost:3000/api/v2/bot/control -H 'content-type: application/json' \
  -d '{"action":"set_risk_limits","maxDailyLossUsd":100,"maxOrderNotionalUsd":500,"maxDailyOrders":300,"maxSharesPerOrder":1000}'
```

## Recovery

| Symptom | Action |
|---|---|
| Process crashed | PM2 restarts it automatically. Read `logs/crash.log` for the structured crash record. Armed standing orders, kill switch, and risk limits are restored from the DB. |
| Quotes frozen, health `degraded` on `marketWs` | Wait one watchdog cycle (30s) — it hard-reconnects zombie sockets. If still stuck after 2 min: `pm2 restart P4`. |
| `unhealthy` and not self-healing | `pm2 restart P4`. The engine adopts any still-live exchange order for the current window instead of duplicating it. |
| Suspected untracked live order | Check `reconcile.untrackedOrderIds` in `/api/v2/bot/status`. Engage the kill switch (does an account-wide cancelAll), verify on the Polymarket UI, then disengage. |
| VPS reboot | `pm2 resurrect` (after a one-time `pm2 save` + `pm2 startup`). The engine restores its ignition state, standing order, kill switch, and risk limits from the DB. |
| DB corruption (extremely unlikely with WAL) | Stop P4, back up `data/edge5.db*`, run `sqlite3 data/edge5.db "PRAGMA integrity_check"`. Restore from backup if needed — only the trades ledger is irreplaceable. |

## Deploying an update

```bash
cd ~/p4 && git pull && pnpm install && pnpm build && pm2 restart P4
pm2 logs P4 --lines 30        # confirm "engine initialized" with the new version tag
curl -s localhost:3000/api/v2/bot/health | head -c 200
```

If `ecosystem.config.js` changed: `pm2 delete P4 && pm2 start ecosystem.config.js && pm2 save`.

## Securing the control API (optional but recommended)

Add to `.env`:

```
BOT_CONTROL_TOKEN=<long random string, e.g. openssl rand -hex 32>
```

All mutating `/api/v2/bot/control` calls then require `Authorization: Bearer <token>` (or `x-bot-token`). Leave unset only if port 3000 is firewalled to localhost.

**Credential hygiene:** `.env` (wallet private key + CLOB creds) has existed in git history. If the repo has ever been pushed anywhere, rotate the wallet key and re-derive CLOB credentials (`DERIVE_CREDENTIALS.md`).

## Monitoring endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/v2/bot/health` | Machine-readable health for uptime monitors (`healthy` / `degraded` / `unhealthy` + per-subsystem checks) |
| `GET /api/v2/bot/status` | Full engine snapshot: position, standing order, `risk`, `reconcile`, `watchdog` |

Point an uptime monitor (or a cron + curl alert) at `/api/v2/bot/health` and alert on anything other than `"healthy"`.
