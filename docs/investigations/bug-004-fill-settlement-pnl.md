# Bug Investigation #004 — Fill Handling, Settlement, Ledger & PnL Correctness

**Priority:** P0
**Scope:** PAPER_V1 (v1) and LIVE_V2 (v2)
**Objective:** Prove that once a standing‑limit (or sniper) order is filled,
the recorded fill, the settlement classification (WIN/LOSS/SCRATCH), the
ledger row, the bankroll movement and the reported PnL are all internally
consistent, idempotent and traceable to primary evidence.

**Verdict:** **No defect found.** The pipeline is correct in both modes and
already exhaustively covered by regression tests. Findings, evidence and
test map are recorded below so any future regression is spotted immediately.

---

## Pipeline traced

```
Executor.checkFill / order-events
        │  (filledPrice, order.shares — possibly reduced by exchange)
        ▼
StandingOrderManager.onFill                       lib/v2/engine/standing-order.ts:1938
  ├── bankroll.debitFixed(cost)                   lib/v2/engine/bankroll.ts:88
  ├── partial-fill detection vs lastSizing        lines 1944-1972 (permanent ORDER_LOG row)
  ├── openTrade(...)  → row status='OPEN'         lib/v2/engine/db.ts:272
  │      • persists side, shares, price, cost,
  │        balanceAfter, tradeUid, orderId, full
  │        JSON explanation (feedAudit, latency,
  │        sizing audit)
  └── FILLED order_log entry
        │
        ▼   (slot rollover OR early resolution)
StandingOrderManager.resolveSlot
  ├── discovery.fetchResolution  (retry × RESOLUTION_ATTEMPTS)
  ├── computeSpotFallback (STRICT: fresh Chainlink + decisive margin)
  └── recordSettlement(pos, winner|null, source)  lib/v2/engine/standing-order.ts:2302
        ├── settledUids guard (in-memory dedup)
        ├── payout  = SCRATCH → cost | WIN → shares | LOSS → 0
        ├── pnl     = payout − cost (0 for SCRATCH)                             ← Identity D
        ├── settleTrade(...) → DB-level WHERE status='OPEN'   lib/v2/engine/db.ts:341
        │      • merges settle explanation into open explanation
        │      • returns 0 rows if already settled → skip credit
        ├── bankroll.settle(payout)  ONLY when settleTrade updated 1 row
        ├── updateSettledBalance(id, balanceNow)                                (display)
        ├── ACCOUNTING INVARIANT: closing == opening + payout                   ← Identity A
        │      → CRITICAL log + permanent order_log row on drift > $0.01
        ├── executor.creditSettlement(payout)                                   (paper wallet mirror)
        └── SETTLED order_log entry + Telegram notify
```

The v2‑sniper strategy uses the same `recordSettlement` shape in
`lib/v2/engine/engine.ts:1272`, with a single‑shot control flow
(`settleSlot()` nulls the in‑memory position pointer before dispatching
`settleOfficial`), so double‑settle is impossible by construction on that
path as well.

## Findings

1. **Fill correctness.** `onFill` records the executor‑reported filled price
   and executor‑reported share count — i.e. what actually matched at the
   exchange — never the pre‑submit estimate. Any exchange reduction
   (partial fill) is detected against `lastSizing.effectiveShares` and
   written to a permanent `order_log` row **and** the trade’s
   `explanation.partialFill` so nothing looks like the engine silently
   changed size (`standing-order.ts:1944-1972`).

2. **Ledger read‑your‑writes.** The fill writes an `OPEN` row synchronously
   (`openTrade`, `db.ts:286-308`) and settlement mutates that same row
   in place via `settleTrade` (`db.ts:341-366`). History transitions
   `OPEN → WIN/LOSS/SCRATCH` in‑place; there is no shadow row.

3. **Settle‑once idempotency (three layers).**
   - `settledUids` in‑memory Set drops repeat `recordSettlement` calls.
   - `settleTrade` uses `UPDATE ... WHERE id = ? AND status = 'OPEN'` so
     a second settle attempt returns `0 rows changed` at the DB level.
   - The bankroll credit is **only** issued when `settleTrade` reports
     `1 row changed`. A second path that lost the race can never
     double‑pay the pool.

4. **PnL identity (Identity D).** For every non‑SCRATCH trade,
   `pnl === payout − cost` with payout `= shares` on WIN, `= 0` on LOSS.
   For SCRATCH, `payout = cost` and `pnl = 0`. Locked at
   `standing-order.ts:2318-2319` and `engine.ts:1278-1279`; asserted by
   `settlement-integrity.test.ts:289-295`.

5. **Bankroll identity (Identity A).** Fill debits exactly `cost`
   (`bankroll.debitFixed`, rounded 4dp), settlement credits exactly
   `payout` (`bankroll.settle`, rounded 4dp). Post‑settlement invariant
   `closing == opening + payout` is checked with a $0.01 tolerance; a
   drift raises a CRITICAL log and a permanent `order_log ERROR` row
   (`standing-order.ts:2383-2406`).

6. **No fabricated outcomes.** When the official Polymarket resolution
   cannot be fetched *and* the strict spot fallback is unusable (stale
   tick, missing strike, or margin below `FALLBACK_MIN_MARGIN_USD`), the
   trade settles **SCRATCH with the entry cost refunded** — never a
   guessed LOSS. Verified by `settlement.test.ts:199-236`.

7. **Boot‑time orphan recovery.** Rows still `OPEN` on process restart
   (position pointer lost) are closed `SCRATCH` **and the entry cost is
   refunded** to the mode’s bankroll KV (`closeOrphanedOpenTrades`,
   `db.ts:384-...`), guarded by `ledger-accounting.test.ts:66-96`. The
   old behaviour destroyed pool money on every restart.

8. **Post‑settlement integrity net.** The `settlement-verifier` sweeps
   recent SETTLED rows against the eventually‑available official
   resolution and auto‑repairs mismatches (WIN booked as LOSS, wrong PnL
   value, spot‑fallback SCRATCH that has since resolved) with fully
   audited bankroll deltas. Covered end‑to‑end by
   `settlement-integrity.test.ts:187-451`.

## Regression coverage (already in the tree)

| Property                                                | Test file / block |
|---------------------------------------------------------|------------------|
| Bankroll debit + credit = PnL                           | `accounting-integrity.test.ts` — RC1 |
| Fixed‑share sizing conformance (Identity D)             | `accounting-integrity.test.ts` — RC2 |
| Settle‑once at the DB level (no double credit)          | `ledger-accounting.test.ts:52-68` |
| Orphan `OPEN` rows → SCRATCH with cost refund           | `ledger-accounting.test.ts:70-105` |
| Explanation merge (open + settle fragments)             | `ledger-accounting.test.ts:107-140` |
| `updateSettledBalance` gated on `SETTLED`               | `ledger-accounting.test.ts:158-166` |
| WIN classification on official resolution               | `settlement.test.ts:184-190` |
| LOSS only on true official loss                         | `settlement.test.ts:192-197` |
| Won‑but‑stale‑spot never books LOSS                     | `settlement.test.ts:199-207` |
| SCRATCH when no resolution + no reliable spot            | `settlement.test.ts:210-221` |
| Strict spot fallback (fresh + decisive margin only)     | `settlement.test.ts:223-233` |
| Payout math: WIN=shares, LOSS=0, SCRATCH=cost           | `settlement-integrity.test.ts:296-300` |
| Auto‑repair wrong LOSS→WIN (delta credit + wallet)      | `settlement-integrity.test.ts:302-334` |
| SCRATCH → WIN / LOSS priority re‑verification           | `settlement-integrity.test.ts:336-397` |
| Verifier auto‑repairs wrong‑PnL right‑label rows        | `settlement-integrity.test.ts:400-416` |
| Balance‑chain audit (report‑only)                       | `settlement-integrity.test.ts:440-451` |
| One‑order‑per‑window (no duplicate fill row)            | `standing-order.test.ts:346-380` |

## Reviewer checklist (future changes must preserve)

- Every fill writes exactly one `OPEN` row and every settlement mutates
  exactly that row in place (`settleTrade`, not `insertTrade`).
- `bankroll.settle(payout)` is only reachable when `settleTrade` returned
  `1 row changed`, otherwise the pool is double‑paid.
- `payout` and `pnl` formulas remain literally `shares/0/cost` and
  `payout − cost` — no rounding shortcut, no derived “win probability”.
- Any new resolution source funnels through `recordSettlement(pos, winner,
  source)` so the `settledUids` guard and the accounting invariant
  fire uniformly.
- SCRATCH is the only correct behaviour on unverified data; new fallback
  logic must remain **strict** (fresh feed + decisive margin) or default
  to SCRATCH.

## Conclusion

The fill → settlement → ledger → PnL pipeline is behaving correctly in
both v1 and v2. No production code changes are required for Bug #4. The
report above serves as the audit record and the checklist above pins the
invariants so future edits cannot silently regress them.
