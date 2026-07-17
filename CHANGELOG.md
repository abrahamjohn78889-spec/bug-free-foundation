# Changelog

All notable changes to P4 are documented here.

## [Unreleased]

### Fixed

- **Bug #006 — Paper simulator invents partial fills, breaking FIXED_SHARES
  ledger contract (P0, PAPER_V1 only).** `DEFAULT_CHAOS.partialFillRate` was
  0.15, so a FIXED_SHARES=7 order would occasionally book as 2 or 3 shares in
  the paper ledger even though real Polymarket books absorb single-dollar
  orders fully. Downstream this also distorted PERCENT compounding review.
  Fix: default `partialFillRate` to 0; chaos remains opt-in via the
  `PaperExecutor` constructor for adversarial simulations. LIVE_V2 unaffected.
  Regression tests: `tests/integration/bug-006-paper-partial-fill.test.ts`.
  Report: `docs/investigations/bug-006-paper-partial-fill.md`.



### Fixed

- **Bug #005 — Compounding uses stale bankroll (P0).** `rolloverSlot` dispatches
  `settleOfficial` asynchronously, so a PERCENT-mode trigger in the new slot
  could execute before the previous slot's payout was credited, sizing from a
  stale balance. Fix: track pending-settlement tradeUids and withhold
  PERCENT sizing (new status `WAITING_SETTLE`) until every prior lot is
  credited. FIXED_SHARES / FIXED_USD unchanged. Regression tests in
  `tests/integration/bug-005-compounding-staleness.test.ts`. Report:
  `docs/investigations/bug-005-position-sizing-compounding.md`.



### Investigations

- **Bug #001 — Wrong Prediction Direction / Incorrect Market Side Selection (P0).**
  Full end-to-end trace of the decision pipeline from Gamma market discovery
  through CLOB feed, majority-side selection, lock timing, trigger logic,
  execution-window state, serialization, exchange submission, fill polling and
  settlement verification. **Verdict: defect confirmed upstream of
  serialization and fixed in both v1 (PAPER) and v2 (LIVE).** Report:
  `docs/investigations/bug-001-wrong-direction.md`.
- **Bug #002 — Majority Side Selection & Locking Logic (P0).**
  Traced majority calculation, strike capture, freshness gates, and the full
  window-open → trigger → fill lifecycle. **Verdict: defect confirmed — direction
  was locked at trigger fire instead of at window open, allowing a mid-window
  BTC flip to change the locked side.** Report:
  `docs/investigations/bug-002-majority-lock.md`.
- **Bug #003 — Standing Limit Order Placement, Pricing & Sizing (P0).**
  Traced the full pipeline `Feed → Majority → Lock → Order Prep → Trigger →
  Risk → Serialization → Submission → Fill` in both PAPER_V1 and LIVE_V2.
  Verified side, limit price, share count, and tokenId are preserved end-to-end;
  order is armed once, submitted once, never before window-open or after
  settlement. **Verdict: no defect — the pipeline matches the strategy spec
  after Bug #001/#002 fixes.** Added regression tests locking the behaviour.
  Report: `docs/investigations/bug-003-standing-order.md`.
- **Bug #004 — Fill Handling, Settlement, Ledger & PnL Correctness (P0).**
  Traced `Executor fill → onFill (debit + OPEN ledger row + partial-fill audit)
  → resolveSlot → recordSettlement (settledUids + DB-idempotent settleTrade
  + gated bankroll.settle + accounting invariant + wallet mirror + audited
  order_log)` in both PAPER_V1 and LIVE_V2. Confirmed WIN/LOSS/SCRATCH
  classification, PnL = payout − cost, one-and-only-one settlement per fill,
  strict SCRATCH-on-unverified-data, orphan-refund on restart, and
  post-settlement auto-repair. **Verdict: no defect — pipeline correct and
  already covered by existing regression suites (mapped in the report).**
  Report: `docs/investigations/bug-004-fill-settlement-pnl.md`.
- **Bug #004b — Post-repair PnL / explanation mismatch on the compounding
  ledger (P0).** After the settlement-verifier auto-repaired a soft-settled
  trade (SCRATCH / spot-fallback / wrong side) against the official Polymarket
  resolution, the row's STATUS + PnL columns reflected the corrected outcome
  but the human-readable `settlement`, `pnlCalc`, `resolvedWinner`, and
  `resolutionSource` fields inside `explanation` stayed frozen at the original
  booking. The ledger UI then showed contradictions like "LOSS −$9.00" next to
  "SCRATCH — cost refunded; realized PnL $0.0000", and correctly-repaired WINs
  read like losses. Report: `docs/investigations/bug-004b-post-repair-mismatch.md`.

### Fixed

- **Post-repair explanation coherence (Bug #004b):** `repairTrade` now
  overwrites `settlement`, `pnlCalc`, `resolvedWinner`, and `resolutionSource`
  inside the same atomic explanation merge that rewrites `result` / `pnl` /
  `mark_price`, so every auto-repaired ledger row tells a single coherent
  story (STATUS, PnL, "WHY IT SETTLED THIS WAY", and "PNL MATH" all agree).
  The original booked values are still preserved forever inside
  `settlementRepair.old` for the audit trail. Applies to PAPER_V1 and LIVE_V2.
  Regression test in `tests/integration/settlement-integrity.test.ts`.


- **Standing limit direction selection:** replaced race-to-trigger side
  selection with BTC-reference majority-only trigger selection. The bot now
  monitors only the majority side (fresh BTC reference vs captured candle
  strike) and ignores opposite-side trigger touches. Added forensic audit fields
  and regression tests for the observed production failure shape.
- **Window-open direction lock (Bug #002):** `lockedDirection` is now frozen
  at the first eligible tick inside the entry window, using the BTC-reference
  majority at that instant. Later BTC flips or opposite-side trigger touches
  cannot change the committed side. When majority is unavailable at
  window-open the engine HOLDs (`NO_DATA`) instead of guessing. Applies to
  both PAPER_V1 and LIVE_V2. Regression tests added in
  `tests/integration/standing-order.test.ts`.
