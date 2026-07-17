#!/usr/bin/env bash
# =============================================================================
# vps-healthcheck.sh — external redundancy for the in-process health monitor.
#
# Polls /api/v2/bot/health on a schedule and pushes a Telegram alert whenever
# the endpoint returns non-200 OR is unreachable (process wedged, port closed,
# DNS gone). Complements lib/v2/engine/health-monitor.ts, which cannot fire
# alerts when the Node process itself is dead.
#
# Usage (cron, every minute):
#   * * * * * /path/to/scripts/vps-healthcheck.sh >> /var/log/p4-health.log 2>&1
#
# Env vars (must be exported before running):
#   HEALTH_URL             http://127.0.0.1:3000/api/v2/bot/health   (default)
#   TELEGRAM_BOT_TOKEN     bot token for the OPERATIONS chat
#   TELEGRAM_CHAT_ID       chat id to notify
#   STATE_FILE             /tmp/p4-health.state                       (default)
#
# The state file suppresses duplicate alerts: only transitions (OK→FAIL and
# FAIL→OK) send a Telegram message. Sustained downtime does not spam.
# =============================================================================

set -u

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/v2/bot/health}"
STATE_FILE="${STATE_FILE:-/tmp/p4-health.state}"
TIMEOUT="${TIMEOUT:-10}"

prev="OK"
[ -f "$STATE_FILE" ] && prev="$(cat "$STATE_FILE" 2>/dev/null || echo OK)"

http_code=$(curl -s -o /tmp/p4-health.body -w "%{http_code}" --max-time "$TIMEOUT" "$HEALTH_URL" || echo "000")
body=$(cat /tmp/p4-health.body 2>/dev/null || echo "")

if [ "$http_code" = "200" ]; then
  current="OK"
else
  current="FAIL"
fi

notify() {
  local title="$1"; local detail="$2"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s --max-time 10 \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      -d "parse_mode=HTML" \
      --data-urlencode "text=<b>${title}</b>
${detail}" \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" > /dev/null || true
  fi
  echo "$(date -u +%FT%TZ) $title — $detail"
}

if [ "$prev" != "$current" ]; then
  if [ "$current" = "FAIL" ]; then
    notify "VPS HEALTH FAIL — external probe" "HTTP $http_code from $HEALTH_URL
${body:0:500}"
  else
    notify "VPS HEALTH RECOVERED — external probe" "HTTP 200 from $HEALTH_URL"
  fi
  echo "$current" > "$STATE_FILE"
fi

# Exit non-zero on failure so cron/systemd can escalate if desired.
[ "$current" = "OK" ]
