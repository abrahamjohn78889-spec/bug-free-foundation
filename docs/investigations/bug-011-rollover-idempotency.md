# Bug #011 — Rollover retry could double-book the ledger

**Priority:** P0 (Critical, latent)
**Scope:** PAPER_V1 + LIVE_V2 (both call `StandingOrderManager.onFill`)
**Files:** `lib/v2/engine/standing-order.ts`

## Symptom

None observed in production yet — this is a **latent** defect surfaced during
the "no duplicate ledger / no missing reversal" audit requested for the
rollover retry paths. Under any scenario where two callers reach `onFill`
with the same `exchangeOrderId` (rollover retry after a partial failure,
`pollRestingFill` + `rolloverSlot` final `checkFill` race, or a duplicate
exchange ack) the engine would:

1. Insert **two** rows into `trades` for the same fill (`openTrade` has no
   idempotency key on `order_id`).
2. Call `bankroll.debitFixed(cost)` **twice**, double-debiting the pool.
3. Push **two** lots into `positions`, later double-settling at rollover.

That is the exact "duplicate ledger / missing reversal" family of defects
the audit was asked to prevent.

## Root cause

`onFill` in `standing-order.ts` had no per-order guard. Today the epoch
bump in `rolloverSlot` and the `restingOrder` null-check in
`pollRestingFill` happen to serialize callers so only one wins in
practice, but the invariant is fragile — any retried rollover, thrown
`checkFill`, or exchange-side duplicate ack could reach `onFill` twice.

## Fix

- Added `private bookedFillOrderIds = new Set<string>()` to
  `StandingOrderManager`.
- `onFill` now short-circuits (with an `order_log` breadcrumb) when the
  `exchangeOrderId` is already booked; also clears any stale
  `restingOrder` pointer at the same id.
- `rolloverSlot` clears `bookedFillOrderIds` after cancelling the resting
  order so the next slot starts clean.

## Regression coverage

`tests/integration/bug-011-rollover-idempotency.test.ts` — matrix over
PAPER_V1 and LIVE_V2:

- Duplicate `onFill` for the same order id → 1 ledger row, 1 debit.
- `pollRestingFill` + `rolloverSlot` race → 1 ledger row.
- Rollover retry (throw between clear + cancel) → 1 ledger row.
- New slot clears the guard so the next order books normally.
- Every booked fill has exactly one matching debit (balance equals
  sum-of-costs).
- Drift check on the shipped source keeps the mirror test honest.
