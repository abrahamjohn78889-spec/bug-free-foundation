# Bug #014 — Order submission retry & idempotency across WS reconnects

**Priority:** P0 (Critical) · **Pipelines:** PAPER_V1 + LIVE_V2

## Symptom

When the Polymarket CLOB WebSocket reconnected (or a REST placement timed
out) *while* a trigger-fired standing-order was being submitted, the tick
went through `handlePlacementFailure`, ran a one-shot adoption scan, and
either adopted a match or re-armed the trigger with a 5s/60s cooldown.

There was **no active retry** of the placement itself. If the network
flake was transient and the order was confirmably absent from the book,
the engine stood down and waited for the trigger price to re-cross —
which, in a 15s window, often never happened. Result: legitimate trigger
events could silently miss the fill.

## Root cause

`handlePlacementFailure` did adoption-only recovery: verify → adopt or
give up. It relied entirely on the tick loop coming back around to
retry, gated by `readyForTrigger` re-arming. For edge-triggered modes
inside short windows, that re-arm often never happens because the price
stays above trigger.

## Fix

`lib/v2/engine/standing-order.ts`:

1. **Active retry with backoff.** `handlePlacementFailure` now attempts
   up to 3 total placements with 0.5s / 1.5s / 3s backoff between
   attempts. Between every retry it re-runs the adoption scan first, so
   a slow-ack order that landed on the exchange while we backed off is
   adopted, never duplicated.
2. **Error classifier** (`isTransientPlacementError`). Terminal errors
   (`reject / insufficient / invalid tick / unauthorized / market closed
   / nonce / expired`) stand down immediately — no wasted retries.
   Transient errors (`timeout / socket / ECONN* / network / reconnect /
   disconnect / abort / fetch failed / 5xx / gateway / reset / hang up /
   ws *`) retry.
3. **UNVERIFIABLE guard preserved.** If all 3 adoption scans throw
   (exchange unreadable), the engine refuses to blind-retry and re-arms
   with a 60s cooldown so the reconciler cycle can cross-check any
   untracked live order before another placement could duplicate it.
4. **Adoption ordering invariant.** Adoption scan always runs *before*
   the corresponding retry. Source-drift test in
   `tests/integration/bug-014-submission-retry-idempotency.test.ts`
   asserts this ordering in the shipped source.
5. **Return-value contract.** `handlePlacementFailure` now returns the
   adopted / retried `OpenOrder` on success (caller adopts it into
   `restingOrder`) or `null` on stand-down. Existing epoch/ghost-tick
   guards and the `bookedFillOrderIds` idempotency layer (Bug #011)
   remain the outer safety net.

## Idempotency guarantees preserved

- `onFill` still short-circuits duplicate exchange order IDs (Bug #011).
- `FillReconciler` (Bug #012) still cross-checks CLOB fills ↔ ledger.
- Ghost-tick guard still cancels orphans if the epoch moves during
  placement or retries.
- Retries always adopt first, so a lost-ack fill can never become a
  second live order.

## Regression tests

`tests/integration/bug-014-submission-retry-idempotency.test.ts`:

- Terminal errors are not retried.
- Transient errors are retried.
- Lost-ack orders are adopted (attempt 1, no duplicate).
- Transient failures recover on attempt #2.
- Unverifiable exchange state produces UNVERIFIABLE (never a blind
  duplicate).
- Source-drift check: shipped source still contains `BUG #014`,
  `isTransientPlacementError`, `scanForAdoption`, `placeOrder-retry-*`,
  and calls `scanForAdoption` *before* the retry.
