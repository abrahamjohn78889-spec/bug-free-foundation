#!/usr/bin/env bash
# Extended health monitor: samples /health + watchdog/memory every 15s.
BASE="${1:-http://localhost:3100}"
DURATION="${2:-900}"
LOG=/tmp/health-monitor.log
: > "$LOG"
END=$(( $(date +%s) + DURATION ))
SAMPLES=0; UNHEALTHY=0; DEGRADED=0
PREV_SLUG=""
ROLLOVERS=0
while [ "$(date +%s)" -lt "$END" ]; do
  H=$(curl -s --max-time 10 "$BASE/api/v2/bot/health")
  S=$(curl -s --max-time 10 "$BASE/api/v2/bot/status")
  LINE=$(python3 - "$H" "$S" <<'EOF'
import json,sys
try:
  h=json.loads(sys.argv[1]); s=json.loads(sys.argv[2])
  w=s.get("watchdog") or {}
  lm=s.get("liveMarket") or {}
  q=s.get("clobQuote") or {}
  bad=[k for k,v in h.get("checks",{}).items() if not v.get("ok")]
  print(f'{h.get("status","?")}|{lm.get("slug","")}|rss={w.get("rssMb")}MB heap={w.get("heapUsedMb")}MB checks={w.get("checksRun")} wsfix={w.get("marketWsReconnects")} qfix={w.get("staleQuoteRecoveries")}|bad={",".join(bad) or "-"}|qage={q.get("ageMs")}')
except Exception as e:
  print(f'PARSE_ERR|{e}')
EOF
)
  STATUS=$(echo "$LINE" | cut -d'|' -f1)
  SLUG=$(echo "$LINE" | cut -d'|' -f2)
  SAMPLES=$((SAMPLES+1))
  [ "$STATUS" = "unhealthy" ] && UNHEALTHY=$((UNHEALTHY+1))
  [ "$STATUS" = "degraded" ] && DEGRADED=$((DEGRADED+1))
  if [ -n "$SLUG" ] && [ -n "$PREV_SLUG" ] && [ "$SLUG" != "$PREV_SLUG" ]; then
    ROLLOVERS=$((ROLLOVERS+1))
    echo "$(date -u +%H:%M:%S) ROLLOVER -> $SLUG" >> "$LOG"
  fi
  PREV_SLUG="$SLUG"
  echo "$(date -u +%H:%M:%S) $LINE" >> "$LOG"
  sleep 15
done
echo "=== HEALTH MONITOR SUMMARY ===" >> "$LOG"
echo "samples=$SAMPLES unhealthy=$UNHEALTHY degraded=$DEGRADED rollovers=$ROLLOVERS" >> "$LOG"
