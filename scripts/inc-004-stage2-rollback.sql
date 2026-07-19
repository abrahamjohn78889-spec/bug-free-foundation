-- INC-004 Stage 2 rollback
--
-- Removes the additive intent-model schema introduced in Stage 2. Safe to run
-- at any time BEFORE Stage 4 wires production reads/writes behind
-- INC_004_INTENT_FIRST. After Stage 4 is enabled in production the rollback
-- must be preceded by disabling the flag and draining in-flight intents.
--
-- The teardown is wrapped in a single transaction so a mid-rollback failure
-- leaves the schema untouched.

BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_quarantine_coid;
DROP INDEX IF EXISTS idx_quarantine_exchange;
DROP TABLE IF EXISTS quarantined_exchange_orders;

DROP INDEX IF EXISTS idx_order_intents_exchange;
DROP INDEX IF EXISTS idx_order_intents_status;
DROP INDEX IF EXISTS idx_order_intents_coid;
DROP TABLE IF EXISTS order_intents;

COMMIT;
