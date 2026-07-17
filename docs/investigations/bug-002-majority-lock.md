# Bug Investigation #002 — Majority Side Selection & Locking

**Status:** Defect confirmed and fixed
**Scope:** `PAPER_V1` and `LIVE_V2` (identical strategy code path)
**Priority:** P0

## Executive Summary

The strategy specification requires the majority side to be **locked at the
moment the execution window opens** and used for the rest of the cycle.
Investigation of the pipeline shows the code instead computes majority
continuously and only locks direction **when the trigger fires**. Between
window-open and trigger, the BTC-reference majority can flip (spot oscillating
across the captured strike). If a minority-turned-majority side happens to
reach the trigger first, the engine locks and trades that side even though it
was not the majority at window-open.

The smallest safe correction is to freeze `lockedDirection` at the first
eligible tick inside the entry window (i.e. window-open), and to HOLD when no
majority signal is available at that instant.

## Files Inspected

- `lib/v2/engine/standing-order.ts` (arm, tick, computeMajority,
  btcReferenceDirection, entryWindowOpensInMs, trigger-lock guard)
- `lib/v2/engine/strategy/sniper.ts` (unused by the standing-order path;
  drift-guard reference only)
- `lib/v2/engine/feeds/btc-reference-feed.ts` (spot freshness contract)
- `lib/v2/engine/feeds/clob-price-feed.ts` (validated atomic snapshot API)
- `lib/v2/engine/engine.ts` (owner wiring; does not compute majority)
- `lib/v2/engine/market-model.ts`, `comparison.ts`, `preflight.ts`
  (no majority logic present)
- `tests/integration/standing-order.test.ts` (existing regressions)

## Majority Calculation Methodology

```
btcReferenceDirection():
    strike == null   → null
    spot stale       → null   (>SPOT_STALE_MS)
    spot > strike    → UP
    spot < strike    → DOWN
    spot == strike   → null   (with tie fallback below)

computeMajority(snap):
    side = btcReferenceDirection()
    if side is null AND strike/spot known → tie-break by CLOB best-ask
        up.price >= down.price ? "UP" : "DOWN"
    otherwise HOLD
    price = snap[side].price   // used for trigger evaluation
```

Majority is derived from **BTC spot vs candle strike**. The captured
`strike` is the first fresh spot tick after `arm()` / slot rollover, which
approximates the candle open in normal operation.

## Locking Lifecycle (before fix)

```
arm()          → lockedDirection = null
tick loop      → majoritySide continuously recomputed
window open    → still no lock
BTC flips      → majoritySide flips freely (no lock yet)
trigger fires  → lockedDirection = current side  ← WRONG POINT
```

## Locking Lifecycle (after fix)

```
arm()                 → lockedDirection = null
before window open    → majoritySide recomputed for display only
window opens (t=0)    → lockedDirection = majoritySide (frozen)
                        HOLD if majority is null (no guess)
BTC flips             → lockedDirection unchanged
trigger fires         → triggerLock captured on top (generation+ids)
fill                  → windowFilled = true; no further orders
```

## Root Cause

The trigger-branch at `standing-order.ts` line ~1497 was the sole assignment
site of `lockedDirection`. Because majority was recomputed every tick and
only frozen at trigger fire, the intended window-open lock was never
established. This is deterministic under the following conditions:

- BTC spot oscillates around the captured strike between window-open and
  trigger,
- and the side that ends up dominant at trigger differs from the side that
  was dominant at window-open.

Historically-affected trades: any window where BTC crossed the strike after
the window opened and before the trigger fired. Same code runs for
`PAPER_V1` and `LIVE_V2`, so both are affected identically.

Why existing tests did not catch it: prior regressions asserted the outcome
at trigger time only, and set spot BEFORE arm/first tick — a stable spot
never produced the flip case.

## Fix

Single insertion in `StandingOrderManager.tick`, immediately after the
"window not open yet" early return:

```ts
if (this.lockedDirection === null) {
  if (majority.side === null) {
    if (this.restingOrder) this.cancelRestingOrder()
    if (!this.paused) this.status = "NO_DATA"
    // throttled log + WITHHELD audit
    return
  }
  this.lockedDirection = majority.side
  logEvent("info", `Standing limit DIRECTION LOCKED at window open: BTC-reference majority ${majority.side} …`)
  this.persistState()
}
```

No other behavior changed. The trigger-lock (`generation`, `marketId`,
`upTokenId`, `downTokenId`, `slotEndMs`) is still taken at trigger fire on
top of the earlier direction lock. Rollover / trigger-lock integrity guards
already clear `lockedDirection` when the market identity or feed generation
changes mid-lock, so the earlier lock inherits identical safety.

## Regression Tests Added

`tests/integration/standing-order.test.ts` gains a
`Bug #002 window-open direction lock` block:

1. Locks the majority side at window open and does **not** follow a later
   BTC flip, even when the minority side reaches the trigger first.
2. HOLDS with `NO_DATA` instead of guessing when BTC-reference majority is
   unavailable at window open (no fresh spot / no strike yet).

Existing assertions that expected `lockedDirection` to remain `null` before
trigger were updated to reflect the new (correct) window-open lock timing.

## Risk Assessment

- Same code path drives PAPER_V1 and LIVE_V2 — behavior updates atomically.
- Fix is additive (extra HOLD gate + earlier assignment of an existing
  field); the trigger, sizing, risk-gate, and submission paths are
  untouched.
- Persisted state (`persistState()`) already round-trips `lockedDirection`,
  so a restart mid-window resumes with the locked side intact.

## Recommendation

Ship the fix. Monitor `WITHHELD` rows with reason `window-open-no-majority`
during initial rollout — a sustained rate would indicate the BTC reference
feed is dropping too often at window boundaries and warrants a separate
feed-reliability ticket.
