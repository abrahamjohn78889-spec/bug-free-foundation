# Bug #013 — Paper executor over-paid at limit instead of live ask

**Priority:** P1 (PAPER_V1 only; LIVE_V2 unaffected)
**File:** `lib/v2/engine/execution/paper.ts`
**Found during:** live simulation against real Polymarket 5m BTC market on 2026-07-17.

## Symptom

Live sim log lines:
```
Standing limit TRIGGERED: UP (locked) $0.94 reached trigger $0.85 — submitting LIMIT BUY 5 @ $0.99
[SIM] fill: 5/5 UP @ $0.99 (live ask $0.94 crossed limit)
Standing limit FILLED (#1): UP 5 @ $0.99 (cost $4.95) — ledger #1
```

Live ask was $0.94, but paper booked cost $4.95 (5 × $0.99). On a real Polymarket CLOB the marketable BUY would have crossed into resting sell offers starting at $0.94, so the true fill would be ~$4.70. Paper systematically over-paid `(limit − ask) × shares`, biasing PnL negative vs. live and distorting compounding.

## Root cause

`PaperExecutor.evaluate()` used `resting.order.price` (the limit) as the fill price. `checkFill()` also returned `filledPrice: order.price`. Neither considered that when `liveAsk < limit`, a real taker order fills at the ask.

## Fix

1. Fill price is now `Math.min(limit, liveAsk)` in `evaluate()`.
2. `RestingOrder` accumulates `filledNotional` across (potentially partial) matches.
3. `checkFill()` returns the share-weighted average fill price actually paid, not the outer limit.

## Regression coverage

`tests/integration/bug-013-paper-taker-fill-price.test.ts`:
- Marketable BUY (limit 0.99, ask 0.85) → fill price 0.85.
- Non-marketable maker (limit 0.99, ask 0.99) → fill price 0.99.
