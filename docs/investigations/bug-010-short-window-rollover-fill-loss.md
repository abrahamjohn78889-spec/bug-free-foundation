# Bug #010 — Short-window fill loss at rollover

**Priority:** P0 (Critical)  
**Modes affected:** PAPER_V1 and LIVE_V2  
**Scope:** Standing limit order engine with a short entry time window
(`entryWindowSec` = 5 / 15 / 30 / 45 s)

## Symptom

With a short entry window, the trigger can fire in the last few hundred
milliseconds of the slot. If the resting LIMIT BUY matches on the exchange
between the last `checkFill` poll and the slot boundary, the account owns the
shares on-chain, but the SLO ledger records no position — no OPEN row, no
settlement, no PnL. On LIVE_V2 the shares sit in the wallet unaccounted;
on PAPER_V1 the fill is silently dropped.

## Root cause

`rolloverSlot()` in `lib/v2/engine/standing-order.ts` unconditionally called
`cancelRestingOrder()` at the slot boundary without doing a final fill check.
Because ticks run on an adaptive cadence (250 ms in the hot loop), there is
always up to one cadence's worth of unpolled state when the boundary hits —
tolerable for a long window, catastrophic when the whole window is only 5 s
and the trigger fires late.

## Fix

`rolloverSlot()` now performs one final, epoch-safe `checkFill` on the
resting order before cancellation. If the executor reports a fill it is
booked through `onFill` (ledger + bankroll + settlement queue) exactly as if
a normal tick had detected it, then `cancelRestingOrder` runs to purge any
remainder (`checkFill` in `live.ts` already cancels partial-fill remainders
itself, so this is idempotent).

## Verification

- Applies uniformly to PAPER_V1 (idempotent via `fillReported`) and LIVE_V2
  (idempotent via exchange truth in `getOrder`).
- Regression test: `tests/integration/bug-010-rollover-fill-check.test.ts`.
