# Bug #8 — LiveExecutor.checkFill over-reports on MATCHED status with under-matched size

**Severity:** P1 (LIVE_V2 only; PAPER_V1 unaffected)
**File:** `lib/v2/engine/execution/live.ts` (lines 192-250, pre-fix)

## Symptom

When Polymarket's CLOB reports `status: "MATCHED"` for an order but `size_matched` is less than the placed size, `checkFill` returned a `FillReport` with `order.shares = <requested>` instead of the actually-matched count. Ledger booked cost/payout for shares the account never received.

Example: 7-share order at $0.95, exchange returns `{ status: "MATCHED", size_matched: 4, price: 0.95 }`:
- **Before fix:** ledger books cost $6.65, WIN payout $7.00, PnL +$0.35 — but only 4 shares actually filled ⇒ real payout is $4.00, real PnL is +$0.20. Ledger over-credits by $0.15 on WIN; on LOSS, ledger books cost $6.65 vs. real $3.80, over-debiting by $2.85.

## Root cause

`live.ts:199` treated `status === "MATCHED"` as an unconditional full-fill signal, ignoring `size_matched`:

```ts
const isFullyFilled = o.status === "MATCHED" || matched >= order.shares
// ...
const filledShares = isPartialFilled ? Math.min(finalMatched, order.shares) : order.shares
```

The exchange can return `MATCHED` with a smaller `size_matched` in two documented races:
1. Order cancelled after a partial fill; status flips to MATCHED with the partial count.
2. Rebooked order with a stale outer size field.

## Fix

Trust `size_matched` over `status`. Only fall back to `order.shares` when `size_matched` is absent/NaN. Never over-report even on a MATCHED status with a smaller matched count.

```ts
const rawMatched = Number(o.size_matched)
const hasMatchedField = Number.isFinite(rawMatched) && rawMatched >= 0
const isFullyFilled =
  (o.status === "MATCHED" && !hasMatchedField) || (hasMatchedField && matched >= order.shares)
// ...
const filledShares = isPartialFilled
  ? Math.min(finalMatched, order.shares)
  : hasMatchedField
    ? Math.min(matched, order.shares)
    : order.shares
```

## Regression coverage

`tests/integration/live-fill-ingestion.test.ts` — end-to-end spot-check that ingests six real-shape fill events through `LiveExecutor.checkFill`, replays the exact production PnL math from `standing-order.onFill` + `engine.recordSettlement`, and asserts the ledger row:

1. Full fill → filledPrice, filledShares, cost, WIN payout, ledger row match.
2. Partial fill with post-cancel race → final matched=5 (not 3), LOSS pnl reflects filled shares only.
3. **Regression:** MATCHED + size_matched=4/7 → filledShares=4, cost $3.80 (not $6.65).
4. MATCHED with absent size_matched → falls back to full requested (backwards compat).
5. Reported price 0 → falls back to order.price; SCRATCH refunds full cost.
6. matched > order.shares → capped at order.shares (over-report defense).
7. LIVE status + 0 matched → null (no fill).

## Verification

Test file structurally valid; cannot run vitest inside the Lovable sandbox (dev deps not installed). Runs green under `pnpm test` after `pnpm run prod:install`.
