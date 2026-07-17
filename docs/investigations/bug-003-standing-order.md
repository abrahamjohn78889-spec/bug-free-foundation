# Bug #003 — Standing Limit Order Placement, Pricing & Sizing

**Priority:** P0 (Critical)
**Verdict:** **NO DEFECT FOUND.** The standing-order pipeline preserves side,
limit price, share quantity, and token identity through every stage. After the
Bug #001 and Bug #002 fixes, the code matches the authoritative strategy
specification. Regression tests were added to lock the behaviour.

---

## Executive Summary

Traced the full pipeline `Feed → Majority → Lock → Order Prep → Trigger →
Risk → Serialization → Submission → Fill` and validated that:

1. The side placed on the exchange is always the side locked at
   window-open by the BTC-reference majority (Bug #002 fix).
2. The trigger only gates *when* the order fires, never *which side*.
3. The limit price submitted equals `params.limitPrice`, rounded to 2dp,
   never mutated between arm and placement.
4. Share count is computed once at trigger time from the current
   ledger-authoritative bankroll (compounding for `PERCENT`, fixed for
   `FIXED_SHARES` / `FIXED_USD`), capped by `maxSharesPerOrder`, and
   re-validated against pool sufficiency before submission.
5. `tokenId` is derived from the *locked* side using the discovered
   market's `upTokenId` / `downTokenId`, whose UP/DOWN mapping comes
   from the Gamma-API `outcomes` array.
6. The order is armed once, submitted once (`readyForTrigger=false` and
   `windowFilled=true` guards), and never placed outside the configured
   final entry window (`entryWindowMs` gate + last-instant re-check).
7. PAPER_V1 and LIVE_V2 use identical `PlaceOrderRequest` shape and
   both apply the same numeric sanitation (`price.toFixed(2)`,
   `Math.floor(shares)`), so behaviour is identical.

## Standing Order Lifecycle

```text
arm(limit, shares, ...)
  └─ params = { limitPrice, triggerPrice, shares, sizingMode, sizeValue,
                entryWindowMs, minPrice, maxPrice, triggerMode }
  └─ status = ARMED, lockedDirection = null, windowFilled = false
      ↓
tick() (self-scheduling)
  ├─ slot rollover?      → rolloverSlot()
  ├─ strike capture?     → strike = freshSpotPrice() (first fresh tick)
  ├─ snapshot            = clobPriceFeed.validatedQuotes()   [ONE per tick]
  ├─ triggerLock guard   → cancel + release if generation/token IDs changed
  ├─ majority            = BTC spot vs strike               (side, ask)
  ├─ windowFilled?       → cancel resting, status=FILLED, return
  ├─ entry window open?  → if not: status=WINDOW_WAITING, arm precise timer
  ├─ lock direction      = majority.side at window-open (HOLD if null)
  ├─ read locked side    → sidePrice = executionPriceForSide(locked)
  ├─ NO_DATA guard       → cancel resting, HOLD
  ├─ OUT_OF_RANGE guard  → cancel resting, HOLD
  ├─ sidePrice < trigger → status=ARMED, return
  ├─ gate closed         → hold (UPWARD_CROSSING)
  ├─ retry cooldown      → hold
  ├─ orderIds(locked)    → { marketId, tokenId }
  ├─ shares              = computeOrderShares(limitPrice)  [risk clamp]
  ├─ pool sufficiency    → INSUFFICIENT if not enough
  ├─ last-instant window re-check
  ├─ risk gate           → BLOCKED if vetoed
  ├─ readyForTrigger=false, persistState()   [consume the trigger]
  └─ executor.placeOrder({ marketId, tokenId, side=locked,
                            price=limitPrice, shares, tif=GTC })
      ↓
executor.checkFill() → onFill(order, filledPrice=limitPrice)
      ↓
windowFilled = true   (one order per 5-min market)
```

## Order Pricing Flow

`params.limitPrice` is set once by `arm()` (rounded to 2dp) and read verbatim
at submission: `executor.placeOrder({ price: limitPrice, ... })`. Both
`LiveExecutor.clean()` and `PaperExecutor.placeOrder()` re-apply
`Number(price.toFixed(2))`, so no float artifact reaches the CLOB. No code
path mutates `params.limitPrice` — repricing, cancel/replace, retries and
restart recovery all reuse the persisted `params.limitPrice`.

## Order Sizing Flow

```text
computeOrderShares(limitPrice):
  FIXED_SHARES → params.shares
  FIXED_USD    → floor(sizeValue / limitPrice)
  PERCENT      → floor((bankroll.balance + dustReserve) * pct / 100 / limitPrice)
  → cap at risk.getLimits().maxSharesPerOrder   [logged as RISK_CLAMP]
  → re-validate pool: required = limitPrice * shares ≤ pool
  → LiveExecutor / PaperExecutor: size = Math.floor(shares)
```

Bankroll is read at trigger time, not at arm time, so PERCENT sizing
compounds naturally after each settlement.

## Files Inspected

- `lib/v2/engine/standing-order.ts` — orchestrator (arm, tick, sizing,
  window gate, locks, submission).
- `lib/v2/engine/execution/paper.ts` — PAPER_V1 executor.
- `lib/v2/engine/execution/live.ts` — LIVE_V2 executor (Polymarket CLOB v2).
- `lib/v2/engine/execution/executor.ts` — shared `PlaceOrderRequest` type.
- `lib/v2/engine/feeds/market-discovery.ts` — UP/DOWN → tokenId mapping.
- `lib/v2/engine/feeds/clob-price-feed.ts` — `validatedQuotes()` atomic
  snapshot (single choke point).
- `lib/v2/engine/risk.ts` — `checkOrder` gate + `getLimits`.
- `lib/v2/engine/bankroll.ts` — pool source for PERCENT / FIXED_USD.
- `lib/v2/engine/trade-replay.ts` — forensic verdict source of truth.

## Edge Cases Verified

| Case | Behaviour |
| --- | --- |
| Trigger reached immediately at window open | Fires once, locked side wins, `windowFilled=true`. |
| Trigger reached on final tick | Submits only if last-instant window re-check still passes. |
| Price oscillates around trigger | AT_OR_ABOVE fires once (windowFilled), UPWARD_CROSSING requires a fresh dip-then-rise. |
| Majority flips after order armed | Pre-lock: resting order cancelled and re-evaluated. Post-lock: ignored. |
| WS reconnect / REST fallback | Generation unchanged → lock survives. New generation → integrity guard releases lock and cancels the pending order. |
| Restart while waiting for trigger | `persistState()` restores params + `lockedDirection`; resting order adopted by `exchangeOrderId`. |
| Duplicate trigger events | `readyForTrigger=false` set before the await; `windowFilled` blocks re-entry after fill. |
| Cancel/replace path | Uses the same `PlaceOrderRequest` with unchanged `limitPrice` / `tokenId`. |
| Market rollover | `rolloverSlot()` bumps epoch, clears lock + windowFilled, re-resolves market. |
| Concurrent markets | `orderIds(side)` requires `market.slotEndMs === this.slotEndMs` — stale market returns null → `WAITING_MARKET`. |

## PAPER_V1 vs LIVE_V2 Impact

Both executors accept the same `PlaceOrderRequest` shape, apply the same
`toFixed(2)` / `floor(shares)` sanitation, and always submit as `Side.BUY`
against `req.tokenId`. There is no divergence in side/price/quantity/token
handling.

## Regression Tests

Added under `tests/integration/standing-order.test.ts` group
"Bug #003 standing-order placement integrity":

- Majority DOWN → BUY DOWN at `$0.99` with 7 shares, single fill only.
- Trigger only gates timing — a DOWN wick past the trigger does **not**
  flip a UP-locked window; UP eventually fires at the configured limit.

Existing Bug #001 / Bug #002 tests already cover: majority UP fills UP,
minority-side wick ignored, direction locked at window open, HOLD on
missing majority, NO_DATA / OUT_OF_RANGE guards, and post-fill hold.

## Root Cause

None. The pipeline is correct after Bug #001 (majority-only trigger) and
Bug #002 (window-open direction lock) landed.

## Risk Assessment

**Zero code change to production paths.** Only the test suite gained new
assertions locking the observed behaviour, so no runtime surface is altered
in either PAPER_V1 or LIVE_V2.

## Final Recommendation

Close Bug #003 as *no defect*. Keep the new regression tests as a
tripwire so any future refactor that decouples side/price/tokenId/shares
from the locked configuration will fail the suite.
