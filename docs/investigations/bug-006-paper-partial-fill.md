# Bug #6 — Paper simulator invents partial fills, breaking FIXED_SHARES contract

Priority: P0. Scope: PAPER_V1 only (LIVE_V2 unaffected — the simulator does not run in live mode).

## Symptom

User's ledger (image-7.png) shows FIXED_SHARES=7 orders at $0.97 mostly booking 7 shares, but trades **#136 booked 3 shares** and **#130 booked 2 shares**. Realized PnL for those rows drops proportionally ($+0.09 / $+0.06 vs the usual $+0.21). User expectation: "with compounding it should be more than the [fixed] limit-order shares, not less."

## Root cause

`lib/v2/engine/execution/paper.ts` `DEFAULT_CHAOS.partialFillRate = 0.15`. On every evaluate() the paper executor rolled a 15% chance to partial-fill, then filled a random 30–80% of the remaining shares:

```ts
const isPartial = Math.random() < this.chaos.partialFillRate && remaining > 1
const fillShares = isPartial
  ? Math.max(1, Math.floor(remaining * (0.3 + Math.random() * 0.5)))
  : remaining
```

For a 7-share order this produces exactly the observed distribution: mostly 7, occasionally 2–4. The remainder is then cancelled at the (simulated) exchange, so the ledger permanently records the reduced size.

## Why the simulation is wrong

- P4 sizes orders in the **single-dollar** range (7 shares · $0.97 ≈ $6.79). Polymarket CLOB book depth at any liquid Bitcoin hourly market dwarfs this by orders of magnitude — real partial fills at this size effectively do not occur.
- The synthetic partial fills therefore do **not** mirror LIVE_V2 behavior. They inject variance that never appears in production.
- Downstream damage:
  1. **FIXED_SHARES contract broken in the paper ledger** — the setting is "buy exactly N shares", but the ledger shows less.
  2. **Compounding review distorted** — a slot that booked 2 shares realizes ~$0.06 instead of ~$0.21, so the next PERCENT slot compounds off a smaller-than-expected balance. Paper-mode PnL curves no longer represent what LIVE_V2 would do.
  3. **User-visible confusion** — the ledger looks like a sizing bug even though the audit trail correctly attributes it to a simulator dial.

## Fix

`DEFAULT_CHAOS.partialFillRate = 0`. The chaos machinery is retained: tests and adversarial simulations can still opt in via the `PaperExecutor` constructor's `chaos` override, and `ZERO_CHAOS` continues to be the deterministic profile used under vitest.

No changes to:
- LIVE_V2 execution (`execution/live.ts`) — real partial fills there are already handled and audited (`PARTIAL_FILL` explanation row + `remainderCancelled` log line).
- Sizing math (`computeOrderShares`) — unaffected.
- FIXED_SHARES / FIXED_USD / PERCENT semantics — unchanged.

## Regression tests

`tests/integration/bug-006-paper-partial-fill.test.ts`:

- `DEFAULT_CHAOS.partialFillRate === 0`.
- `ZERO_CHAOS` remains fully deterministic.
- Chaos machinery still opt-in via constructor override.

## Files changed

- `lib/v2/engine/execution/paper.ts` — default `partialFillRate` set to 0 with in-source explanation.
- `tests/integration/bug-006-paper-partial-fill.test.ts` — new.
- `CHANGELOG.md` — Unreleased entry.
