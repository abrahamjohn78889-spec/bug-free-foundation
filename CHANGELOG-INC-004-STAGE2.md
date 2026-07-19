# INC-004 — Stage 2 (Additive Schema Migration)

## Modified
- `lib/v2/engine/db.ts`
  * `getDb()`: additive `CREATE TABLE IF NOT EXISTS order_intents` and
    `quarantined_exchange_orders` + supporting indexes. No existing table,
    column, or index changed. No UNIQUE constraints (Stage 6).
  * Appended: `IntentStatus` enum, `OrderIntentRow` type, and lifecycle
    helpers `createPendingIntent`, `markIntentSubmitted`, `markIntentResting`,
    `markIntentAmbiguous`, `markIntentFailed`, `quarantineExchangeOrder`,
    plus read helpers `getIntentById`, `getIntentByClientOrderId`. All
    transitions are rowcount-gated (UPDATE ... WHERE id AND status IN (...);
    assert `changes === 1`).

## Added
- `scripts/inc-004-stage2-rollback.sql` — transactional teardown of the two
  new tables + indexes.

## Not modified
- Live execution, StandingOrderManager, Reconciler, ClobAdapter, Strategy,
  Settlement. No production reader or writer of the new schema exists yet.

## Results
- Stage 1 regression suite: **8 passed / 3 failed** (Stage 2 contract-lock
  flipped green; Stages 3, 4, 5/6 still red as designed).
- Historical suite (excluding `soak*`): **35 files / 405 tests / 405 passed**.
