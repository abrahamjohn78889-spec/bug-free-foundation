// ============================================================
// CORE SAFETY HANDLERS — barrel export
//
// Five isolated, pure safeguards wrapped around every active
// edge. Each module is independently unit-testable and shared
// identically by the V1 paper and V2 live pipelines.
// ============================================================

export { evaluateOracleGuard, type OracleGuardResult } from "./oracle-sync-guard"
export { classifyCancelReplace, shouldCancelReplace, type LatencyClassification } from "./cancel-replace-pipeline"
export { computeCompounding, shouldSweepDust, type CompoundResult } from "./dust-compounding"
export { detectOrphan, buildOrphanCounter, type OrphanCounterOrder, type LegStatus } from "./orphan-cleaner"
export { validateOrderSize, type ProtocolValidation } from "./protocol-validator"
