#!/usr/bin/env bash
# Phase 7 soak monitor: samples health, memory, watchdog repairs, market
# rollovers, and event-loop responsiveness. Usage:
#   bash scripts/soak-monitor.sh <base-url> <seconds> <cookie-jar>
BASE="${1:-http://localhost:3100}"
DURATION="${2:-1200}"
JAR="${3:-/tmp/soak-cookies.txt}"
OUT=/tmp/soak-monitor.log
: > "$OUT"

START=$(date +%s)
SAMPLES=0; UNHEALTHY=0; DEGRADED=0
PREV_MARKET=""
ROLLOVERS=0
MAX_RSS=0; MIN_RSS=999999
FIRST_HEAP=0; LAST_HEAP=0

while true; do
  NOW=$(date +%s); ELAPSED=$((NOW-START))
  [ "$ELAPSED" -ge "$DURATION" ] && break

  curl -s --max-time 15 "$BASE/api/v2/bot/health" -o /tmp/soak-h.json 2>/dev/null
  curl -s -b "$JAR" --max-time 15 "$BASE/api/v2/bot/status" -o /tmp/soak-s.json 2>/dev/null

  LINE=$(python3 - "$ELAPSED" <<'PYEOF'
import json, sys
elapsed = sys.argv[1]
try:
    h = json.load(open("/tmp/soak-h.json"))
    s = json.load(open("/tmp/soak-s.json"))
except Exception as e:
    print(f"[{elapsed}s] PARSE-FAIL {e}")
    raise SystemExit
w = s.get("watchdog", {})
# Slot identity = slotEndMs (each 15-min market has a unique end time).
market = str(s.get("slotEndMs") or "none")
print(
    f"[{elapsed}s] status={h.get('status','?')} rss={w.get('rssMb','?')}MB "
    f"heap={w.get('heapUsedMb','?')}MB checks={w.get('checksRun','?')} "
    f"wsfix={w.get('marketWsReconnects','?')} userfix={w.get('userWsReconnects','?')} "
    f"stalefix={w.get('staleQuoteRecoveries','?')} market={market} running={s.get('running','?')}"
)
PYEOF
)
  echo "$LINE" >> "$OUT"

  STATUS=$(echo "$LINE" | grep -o "status=[a-z]*" | cut -d= -f2)
  RSS=$(echo "$LINE" | grep -o "rss=[0-9]*" | cut -d= -f2)
  HEAP=$(echo "$LINE" | grep -o "heap=[0-9]*" | cut -d= -f2)
  MARKET=$(echo "$LINE" | grep -o "market=[^ ]*" | cut -d= -f2)

  SAMPLES=$((SAMPLES+1))
  [ "$STATUS" = "unhealthy" ] && UNHEALTHY=$((UNHEALTHY+1))
  [ "$STATUS" = "degraded" ] && DEGRADED=$((DEGRADED+1))
  if [ -n "$RSS" ]; then
    [ "$RSS" -gt "$MAX_RSS" ] && MAX_RSS=$RSS
    [ "$RSS" -lt "$MIN_RSS" ] && MIN_RSS=$RSS
  fi
  if [ -n "$HEAP" ]; then
    [ "$FIRST_HEAP" -eq 0 ] && FIRST_HEAP=$HEAP
    LAST_HEAP=$HEAP
  fi
  if [ -n "$MARKET" ] && [ "$MARKET" != "none" ] && [ -n "$PREV_MARKET" ] && [ "$MARKET" != "$PREV_MARKET" ]; then
    ROLLOVERS=$((ROLLOVERS+1))
    echo "[${ELAPSED}s] === MARKET ROLLOVER #$ROLLOVERS: $PREV_MARKET -> $MARKET ===" >> "$OUT"
  fi
  [ -n "$MARKET" ] && [ "$MARKET" != "none" ] && PREV_MARKET=$MARKET

  sleep 20
done

{
  echo "==== SOAK MONITOR SUMMARY ===="
  echo "duration=${DURATION}s samples=$SAMPLES unhealthy=$UNHEALTHY degraded=$DEGRADED"
  echo "rollovers=$ROLLOVERS rss_min=${MIN_RSS}MB rss_max=${MAX_RSS}MB heap_first=${FIRST_HEAP}MB heap_last=${LAST_HEAP}MB"
} >> "$OUT"
