# Bug #012 — CLOB fill events dropped `orderID`, blocking end-to-end reconciliation

**Priority:** P0 (Critical, observability)
**Scope:** PAPER_V1 + LIVE_V2
**Files:**
- `lib/v2/engine/types.ts` — extended `LiveAccountTrade`
- `lib/v2/engine/execution/live.ts` — capture `maker_orders[].order_id` + `taker_order_id`
- `lib/v2/engine/execution/paper.ts` — capture resting `exchangeOrderId`
- `lib/v2/engine/fill-reconciler.ts` — new end-to-end reconciliation job

## Symptom

Impossible to answer the audit question "does every booked fill in the
ledger correspond to a real CLOB fill event, and vice versa?" — the
LIVE_V2 executor mapped Polymarket `/data/trades` responses into
`LiveAccountTrade` but dropped the `maker_orders[].order_id` field on the
floor. Without that key there is no way to join a CLOB fill event to the
local `trades` ledger row (which stores `order_id`), so a booking that was
missed on a failed/retried rollover would go undetected outside of a
manual investigation.

## Root cause

`LiveExecutor.getRecentTradesLive` and `PaperExecutor` filled the display
shape but omitted every field the reconciler needs (specifically the
exchange order id). The existing `Reconciler` only compares *open* orders
and wallet balance — it never touched historical fills.

## Fix

1. Added `orderIds: string[]` to `LiveAccountTrade`.
2. LIVE_V2: populate from `maker_orders[].order_id` and `taker_order_id`.
3. PAPER_V1: populate from the simulated resting order's
   `exchangeOrderId`.
4. New `FillReconciler` (60s cadence, 15s startup) with a pure
   `crossCheck` kernel that reports four drift classes:
   - `UNBOOKED_FILL` — CLOB has a fill for an order id with no ledger row
     (missing-reversal signal on failed rollover; the Bug #010 regression
     detector at the observability layer).
   - `UNATTRIBUTED_FILL` — CLOB fill carries no order id (LIVE_V2
     escalated to `error`, PAPER_V1 downgraded to `warn`).
   - `DUPLICATE_BOOKING` — two ledger rows share an exchange order id
     (Bug #011 guard bypass or DB corruption).
   - `ORPHAN_LEDGER_ROW` — ledger row with an order id the CLOB never
     reported filling (synthesized booking).
5. Read-only guarantee: findings persist to `order_log` as `ERROR` events;
   the reconciler never places, cancels, or updates orders/rows.
6. Per-key dedupe so a persistent drift logs once, not every 60s.

## Regression coverage

`tests/integration/bug-012-fill-reconciler.test.ts` — pure-kernel matrix
across PAPER_V1 and LIVE_V2 covering the clean case, all four drift
classes, the exact bug #010 / bug #011 failure patterns, and the "pure
function" invariant (same inputs → identical output).

## Wiring

The `FillReconciler` follows the same lifecycle contract as `Reconciler`
(`start()` / `stop()` / `latest`); it is not yet installed in `engine.ts`.
The engine wiring is a one-line addition next to the existing reconciler
and can land in a follow-up without touching the trading path.
