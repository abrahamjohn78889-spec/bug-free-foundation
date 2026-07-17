# Bug #7 — Bankroll Consistency & Balance Synchronization

Priority: P0. User investigation spec: "Bug Investigation Specification #6 — Bankroll Consistency & Balance Synchronization". Internal ID **#7** because #6 was already claimed by the paper partial-fill fix.

## Executive summary

Traced the complete bankroll lifecycle end-to-end across both pipelines. Verdict:

| Concern | Verdict |
|---|---|
| Initialization / authoritative source | ✅ Correct. Single class `Bankroll` (`lib/v2/engine/bankroll.ts`), kv-persisted, mode-namespaced. |
| Debit on fill | ✅ Correct. `debitFixed(cost)` per SLO fill, ledger-first-then-dust, 4dp rounding. |
| Credit on settlement | ✅ Correct. `settle(payout)` per resolved lot, guarded by `settleTrade` idempotency (won't credit twice for the same DB row). |
| Per-settlement invariant | ✅ Correct as far as it goes. `expectedClosing = openingTotal + payout`; CRITICAL order_log row on drift > $0.01. |
| Partial-fill accounting | ✅ Correct. Executor caps `order.shares` to matched count; permanent `PARTIAL_FILL` audit + `sizing.partialFill` ledger explanation. |
| Cancelled / failed orders | ✅ Correct. No bankroll mutation before a fill; cancel paths do not touch balance. |
| Restart recovery | ✅ Correct. Bankroll is kv-backed; restart reads persisted `balance`, `dust`, `starting`. |
| Duplicate settlement events | ✅ Correct. `settledUids` in `StandingOrderManager` + `settleTrade`'s `updated===0` guard both prevent double-credit. |
| PAPER_V1 mirror | ✅ Correct. Authority-follows-mirror was reversed in an earlier fix; wallet is now re-seeded FROM the ledger on every reconciliation cycle. Drift is logged, ledger is never stomped. |
| PAPER_V1 vs LIVE_V2 parity | ✅ Correct at the mutator layer — both pipelines use the same `Bankroll` class and same `debitFixed`/`settle` seams. |
| **LIVE_V2 on-chain reconciliation** | ❌ **DEFECT — fixed here.** `syncLiveBalance` unconditionally overwrote `bankroll.balance` from on-chain USDC on every rollover, racing the async `settleOfficial`. |

## Root cause (LIVE_V2 only)

`lib/v2/engine/engine.ts` slot-rollover branch:

```ts
if (slotEnd !== this.slotEndMs) {
  ...
  await this.settleSlot()                    // dispatches settleOfficial async
  ...
  void this.syncLiveBalance()                // reads on-chain, overwrites ledger
}
```

And in the pre-fix `syncLiveBalance` LIVE_V2 branch:

```ts
this.bankroll.balance = Math.max(0, Math.round((usd - this.bankroll.dustReserve) * 10000) / 10000)
```

Race sequences that break the ledger:

1. **Double-credit.** On-chain redemption for the just-resolved slot lands before the async `settleOfficial` completes. `syncLiveBalance` snaps ledger up by +payout. `recordSettlement` then runs `bankroll.settle(payout)` → payout is counted twice. The per-settlement accounting invariant reads `openingTotal` AFTER the stomp, so `openingTotal + payout` matches the (already-inflated) closing total and the drift is silently accepted.
2. **Lost credit (rarer).** Ledger completes `settleOfficial` first (uses Chainlink resolution). On-chain USDC hasn't reflected a redemption yet. `syncLiveBalance` snaps ledger DOWN to on-chain, erasing the just-credited payout. Every subsequent PERCENT compound uses the deflated pool.

Determinism: intermittent — depends on the exact interleaving of Chainlink resolution, Polymarket redemption, and the 50 ms tick loop. More likely under fast-resolving markets and low network latency.

Historical impact: any LIVE_V2 session where on-chain USDC changed between fill and next-rollover could exhibit this. PAPER_V1 sessions are unaffected — that branch has always been authority-follows-mirror.

## Fix (smallest safe correction)

Two surgical changes:

1. `lib/v2/engine/standing-order.ts` — expose a read-only accessor `pendingSettlementCount()` that returns `this.pendingSettlementUids.size` (set already maintained by bug #5's fix).
2. `lib/v2/engine/engine.ts` `syncLiveBalance` — in the LIVE_V2 branch, defer the overwrite when any of the following are true:
   - `standingOrders.pendingSettlementCount() > 0` — an async payout hasn't been credited yet.
   - `this.pendingResolutions > 0` — a resolution poll is in flight.
   - `this.openOrder !== null` — a fill/cancel is outstanding.

   The deferral logs an `info` line naming which condition tripped. Next rollover retries; on-chain isn't going anywhere.

No changes to PAPER_V1 accounting, the fill/settle mutators, or the per-settlement invariant. No schema change, no wire-format change.

## Regression tests

`tests/integration/bug-007-bankroll-reconciliation.test.ts`:

- `pendingSettlementCount` exists on the manager prototype (the engine's call site is `this.standingOrders?.pendingSettlementCount()`).
- The gating predicate replayed independently matches the four defer/allow cases.
- `Bankroll.debitFixed`/`.settle` cycle 100 times over a 7-share $0.97 WIN pattern and land exactly at the arithmetic ideal ($10,021.0000) — no float drift, ledger arithmetic is bit-stable.

Existing coverage this investigation relied on:
- `tests/integration/accounting-integrity.test.ts` — per-trade PnL and pool identity.
- `tests/integration/ledger-accounting.test.ts` — pool = starting + Σ PnL.
- `tests/integration/settlement-integrity.test.ts` — idempotency guards.
- `tests/integration/bug-005-compounding-staleness.test.ts` — `pendingSettlementUids` maintenance.

## Files inspected

- `lib/v2/engine/bankroll.ts` (all 99 lines)
- `lib/v2/engine/engine.ts` — `syncLiveBalance`, `settleSlot`, `settleOfficial`, `recordSettlement`, ignition, mode swap, `setPaperBalance`
- `lib/v2/engine/standing-order.ts` — `onFill` (debit path), `rolloverSlot`, `recordSettlement` (idempotency + invariant)
- `lib/v2/engine/reconciler.ts` — read-only exchange-truth cross-check (does NOT mutate bankroll)
- `lib/v2/engine/settlement-repair.ts` — one-shot repair path (uses `Bankroll.settle` with delta; idempotent via `updated===0`)
- `lib/v2/engine/settlement-verifier.ts` — report-only; never writes bankroll
- `lib/v2/engine/accounting-verifier.ts` — 5-min report-only identity checks
- `lib/v2/engine/analytics.ts` — read-only for reporting
- `lib/v2/engine/execution/paper.ts` — wallet mirror, `getAvailableBalanceUsd`, `setWalletUsd`, `creditSettlement`
- `lib/v2/engine/execution/live.ts` — `getAvailableBalanceUsd` (USDC read)
- `lib/v2/engine/telegram.ts` — read-only display

## Edge-case matrix

| Edge case | Behavior | Verdict |
|---|---|---|
| Winning streak | `settle(payout)` per lot, 4dp-rounded; invariant checked | ✅ |
| Losing streak | `settle(0)`; entry cost stays debited | ✅ |
| Partial fill | Executor caps `order.shares`; audit trail on ledger; bankroll debited exactly by matched cost | ✅ |
| Cancelled order | No bankroll mutation (debit happens only on fill) | ✅ |
| Failed order | Same as cancelled — no debit occurred | ✅ |
| Duplicate settlement | `settleTrade` returns 0 for already-settled row → bankroll credit skipped | ✅ |
| Restart during settlement | kv-persisted balance survives; `pendingSettlementUids` is in-memory only, but the DB row remains OPEN so the next boot's orphan-recovery path settles it exactly once | ✅ |
| Reconnect during execution | Ticks continue against persisted state; standing-order restoreFromDisk rehydrates positions | ✅ |
| Manual deposit / withdrawal (LIVE_V2) | On-chain drifts; next quiet rollover (no pending settle/resolution/order) reconciles WITH permanent order_log audit row | ✅ |
| Multiple concurrent markets | Single 5-min market per slot in current design; the fix is per-manager so multi-market extension inherits the guard | ✅ |
| Consecutive trades without restart | Debit → settle → debit → settle cycle proven bit-stable over 100 iterations in the new regression test | ✅ |

## PAPER_V1 impact

None — the paper branch is untouched. Wallet mirror remains authority-follows-ledger.

## LIVE_V2 impact

- Removes the double-credit / lost-credit race window on every rollover.
- Worst-case downside: reconciliation is deferred by one 5-min slot when a settlement is in flight at rollover. On-chain remains the eventual source of truth. External deposits/withdrawals are still detected — just on the next quiet rollover.

## Risk assessment

- Blast radius: LIVE_V2 `syncLiveBalance` only. PAPER_V1 unchanged.
- Failure mode of the fix: over-cautious deferral (missed audit cycle). Safe.
- No new state introduced; the `pendingSettlementUids` set already existed from bug #5.

## Final recommendation

Ship. The fix removes the last unaudited path capable of silently corrupting the LIVE_V2 bankroll.
