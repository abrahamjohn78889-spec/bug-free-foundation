# Bug #009 — LIVE_V2 rejects every standing-order trigger fire (post-only vs. marketable)

**Severity:** P0 (LIVE_V2 only; PAPER_V1 unaffected — paper doesn't enforce post-only)
**Files:** `lib/v2/engine/execution/live.ts`, `lib/v2/engine/execution/executor.ts`, `lib/v2/engine/standing-order.ts`
**Reported scenario:** Standing limit order with **no time window, trigger price 70¢, limit price 85¢**.

## Symptom

Every triggered standing-order placement is rejected by Polymarket CLOB with a "would cross the spread" / post-only violation. On LIVE_V2 no fill is ever booked. Paper mode fills normally because the paper simulator resolves fills from the live ask without enforcing post-only.

## Root cause

`live.ts:43` hard-coded `const POST_ONLY = true` and passed it verbatim into `createAndPostOrder`. Meanwhile the standing-order design is:

1. `armStandingOrder` validates `triggerPrice ≤ limitPrice` (`standing-order.ts:544`).
2. Trigger fires when the ask reaches `triggerPrice` (`standing-order.ts:1439`, `if (sidePrice < triggerPrice) hold; else fire`).
3. Order is submitted at `limitPrice`.

Because `limitPrice ≥ triggerPrice ≥ ask` at fire time, the submitted BUY is **marketable by definition**. Post-only rejects it before it can rest or match.

For trigger 70¢ / limit 85¢: trigger fires at ask ≥ 0.70; the order at 0.85 crosses any ask in [0.70, 0.85] and is rejected. Only when ask > 0.85 would post-only accept — but at that point limit 0.85 is not marketable and simply rests.

## Fix

Per-request `postOnly` flag on `PlaceOrderRequest`, default `true` (backwards-compatible safe default for the classic quote loop in `engine.ts:1097`, which relies on maker rebates). Standing-order's trigger-fire placement sets `postOnly: false`.

```ts
// executor.ts
export interface PlaceOrderRequest {
  // …existing fields
  /** false → allow immediate matching (taker). Standing-order trigger uses this. */
  postOnly?: boolean
}

// live.ts placeOrder
const postOnly = req.postOnly ?? POST_ONLY_DEFAULT
await this.client.createAndPostOrder(..., postOnly)

// standing-order.ts trigger fire
await this.executor.placeOrder({ ..., postOnly: false })
```

Paper ignores the field (it simulates fills from the live ask and never enforced post-only).

## Blast radius

- `standing-order.ts:1644` — only call site changed to `postOnly: false`.
- `engine.ts:1097` (classic quote loop) — unchanged, still defaults to post-only (correct for maker rebate strategy).
- All other executor consumers (paper, cancelReplace) — unaffected because the default is preserved.

## Regression coverage

`tests/integration/bug-009-live-postonly.test.ts`:

1. Default (unset) → post-only true (classic quote loop safety).
2. Explicit true → post-only true.
3. Standing-order fire (false) → post-only false forwarded to CLOB.
4. Marketable scenario (limit 0.85 vs ask 0.72) → post-only false.

## User-visible outcome after fix

Trigger 70¢ / limit 85¢ on LIVE_V2: trigger fires at ask ≥ 0.70, order submits at 0.85 as taker-allowed GTC, and CLOB accepts it. It matches the best-priced ask up to 0.85 immediately, per real Polymarket CLOB behavior.
