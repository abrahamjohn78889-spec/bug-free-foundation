#!/bin/bash
# 15-minute continuous monitor: samples /api/v2/bot/status every 10s.
# Logs one line per sample + flags slot rollovers and anomalies.
# Usage: bash scripts/monitor-15m.sh [base_url] [duration_s]
BASE="${1:-http://localhost:3100}"
DUR="${2:-930}"
OUT="${MONITOR_LOG:-/tmp/monitor.log}"
END=$(( $(date +%s) + DUR ))
PREV_SLUG=""
ROLLOVERS=0
SAMPLES=0
FAILS=0
STALE=0
WS_DOWN=0
echo "ts,phase,slug,tminus_s,upask,downask,fresh,ws_conn,api_ms,ws_rtt_ms,consec_fails,book_up_bidlvls" > "$OUT"
while [ "$(date +%s)" -lt "$END" ]; do
  J=$(curl -s --max-time 8 "$BASE/api/v2/bot/status")
  if [ -z "$J" ]; then
    FAILS=$((FAILS+1)); echo "$(date +%T),FETCH_FAIL" >> "$OUT"; sleep 10; continue
  fi
  LINE=$(echo "$J" | python3 -c "
import json,sys
try:
  s=json.load(sys.stdin)
except Exception:
  print('PARSE_FAIL'); raise SystemExit
d=s.get('clobDiagnostics') or {}
ws=d.get('ws') or {}
lm=s.get('liveMarket') or {}
q=s.get('clobQuote') or {}
up=(q.get('up') or {}).get('ask'); dn=(q.get('down') or {}).get('ask')
book=(s.get('clobBook') or {}).get('up') or {}
print(','.join(str(x) for x in [s.get('phase'), lm.get('slug'), round((s.get('tMinusMs') or 0)/1000), up, dn, s.get('clobPricesFresh'), ws.get('connected'), d.get('apiLatencyMs'), ws.get('pingRttMs'), d.get('consecutiveFailures'), book.get('bidLevels')]))
")
  SAMPLES=$((SAMPLES+1))
  SLUG=$(echo "$LINE" | cut -d, -f2)
  if [ -n "$PREV_SLUG" ] && [ "$SLUG" != "$PREV_SLUG" ] && [ "$SLUG" != "None" ]; then
    ROLLOVERS=$((ROLLOVERS+1))
    echo "$(date +%T),ROLLOVER,$PREV_SLUG -> $SLUG" >> "$OUT"
  fi
  [ "$SLUG" != "None" ] && PREV_SLUG="$SLUG"
  FRESH=$(echo "$LINE" | cut -d, -f6)
  [ "$FRESH" = "False" ] && STALE=$((STALE+1))
  WSC=$(echo "$LINE" | cut -d, -f7)
  [ "$WSC" = "False" ] && WS_DOWN=$((WS_DOWN+1))
  echo "$(date +%T),$LINE" >> "$OUT"
  sleep 10
done
echo "===SUMMARY===" >> "$OUT"
echo "samples=$SAMPLES rollovers=$ROLLOVERS fetch_fails=$FAILS stale_samples=$STALE ws_down_samples=$WS_DOWN" >> "$OUT"
