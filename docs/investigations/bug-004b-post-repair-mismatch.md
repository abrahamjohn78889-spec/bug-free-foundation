# Bug #004b — Post-repair PnL / explanation mismatch on the compounding ledger

**Priority:** P0 (Critical — accounting integrity)
**Modes affected:** PAPER_V1 and LIVE_V2 (both go through `repairTrade`)
**Status:** Fixed

## Symptom

The compounding ledger showed rows whose STATUS + PnL columns contradicted the
"WHY IT SETTLED THIS WAY" / "PNL MATH" explanation blocks:

- Row STATUS: `LOSS` (or `WIN`)
- REALIZED PNL column: e.g. `-$9.00` (or `+$0.10`)
- Expanded detail — "WHY IT SETTLED THIS WAY":
  `SCRATCH — no reliable market resolution (source: scratch); the entry cost was refunded so the slot nets exactly zero`
- Expanded detail — "PNL MATH":
  `cost $9.9000 refunded; realized PnL $0.0000`

Users observed a correctly-entered trade (side matches the official market
resolution) rendered as a LOSS on the ledger while the expanded audit trail
insisted the slot had settled SCRATCH with the cost refunded and zero PnL.

## Root cause

`repairTrade` in `lib/v2/engine/settlement-repair.ts` is the atomic path the
settlement-verifier uses to correct a settled row against the official
Polymarket resolution. Before this fix it only rewrote:

- `result` (SCRATCH / LOSS → WIN or vice versa)
- `pnl` (recomputed from the official winner)
- `mark_price` (1 for WIN, 0 for LOSS)
- `explanation.settlementRepair` (a new sub-object with old/new values)

The original human-readable fields inside `explanation` — `settlement`,
`pnlCalc`, `resolvedWinner`, and `resolutionSource` — were **left frozen at
the initial booking**. The ledger UI (`components/v2/ledger.tsx`, `parseExplanation`)
renders exactly those fields, so a trade that was booked SCRATCH and later
correctly repaired to WIN or LOSS still showed the SCRATCH refund narrative.

Impact:

1. Correct WIN repairs looked like SCRATCH/LOSS to the operator.
2. Correct LOSS repairs from spot-fallback misclassification looked like SCRATCH.
3. Audit trail was internally inconsistent — automated PnL exports and manual
   reconciliation both diverged from the actual booked pnl/result.
4. Compounding math on the DB side was correct (bankroll + `balance_after`
   both reflect the repaired PnL), but the ledger dashboard misrepresented
   the outcome, breaking trust in the accounting surface.

## Fix

`repairTrade` now overwrites the four human-readable fields inside the same
atomic explanation merge that rewrites `result` / `pnl` / `mark_price`. The
merge order is preserved so the corrected values always win over stale
originals, and the `settlementRepair` sub-object still records the previous
values (`old.result`, `old.pnl`, `old.payout`) for the permanent audit trail.

After repair, every field the UI shows reflects the same corrected outcome:

- STATUS = repaired result (WIN / LOSS)
- REALIZED PNL = repaired pnl
- EXIT / SETTLE PRICE = repaired mark_price
- WHY IT SETTLED THIS WAY = "WIN|LOSS — bet X, official winner Y (source: settlement-repair); … [auto-repaired from PRIOR]"
- PNL MATH = "payout $P − cost $C = ±$PnL [auto-repaired]"
- (audit) `settlementRepair.old` = the original SCRATCH / wrong booking, with
  timestamp, requestedBy, evidence pointer.

The wallet mirror, bankroll delta, order_log REPAIRED row, CRITICAL log line,
and Telegram alert were already correct and are unchanged.

## Verification

- `tests/integration/settlement-integrity.test.ts` — added regression covering
  SCRATCH → WIN and SCRATCH → LOSS repairs, asserting the four
  explanation fields are rewritten while `settlementRepair.old` retains the
  original values.
- Manual re-render of the affected ledger row: STATUS, PnL, EXIT PRICE, WHY
  IT SETTLED, and PNL MATH now agree.

## Files changed

- `lib/v2/engine/settlement-repair.ts` — merge corrected settlement fields
  into the explanation JSON alongside the existing `settlementRepair` block.
- `tests/integration/settlement-integrity.test.ts` — regression test.
- `CHANGELOG.md` — investigation + fix entries.
