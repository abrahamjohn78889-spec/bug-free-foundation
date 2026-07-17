# Bug #1 Investigation Plan — Wrong Prediction Direction

## Goal

Prove or disprove that P4 ever submits an order on the opposite side of what the strategy intended. Cover both `v1` (paper) and `v2` (live) code paths. No behavioral changes until a root cause is identified with evidence.

## Scope (files to trace)

Decision pipeline as it exists in `/tmp/p4/P4-master`:

```text
Market data feeds
  lib/v2/engine/feeds/{clob-ws-client,clob-price-feed,btc-reference-feed,market-discovery,order-events,account-sync}.ts
        │
        ▼
Signal / majority-side selection
  lib/v2/engine/strategy/sniper.ts
  lib/v2/engine/strategy-registry/strategies/edge{1..6}*.ts
  lib/v2/engine/strategy-registry/registry.ts
  lib/v2/engine/market-model.ts
        │
        ▼
Standing-order arm / trigger / majority lock
  lib/v2/engine/standing-order.ts   (2,489 lines — primary suspect surface)
  lib/v2/engine/engine.ts
  lib/v2/engine/risk.ts, preflight.ts, comparison.ts
        │
        ▼
Execution + serialization
  lib/v2/engine/execution/executor.ts
  lib/v2/engine/execution/paper.ts   ← v1 PAPER path
  lib/v2/engine/execution/live.ts    ← v2 LIVE path
  lib/v2/engine/handlers/{cancel-replace-pipeline,protocol-validator,oracle-sync-guard,orphan-cleaner,dust-compounding}.ts
        │
        ▼
Settlement / replay / ledger
  lib/v2/engine/{settlement-verifier,settlement-repair,reconciler,trade-replay,report,analytics,bankroll}.ts
  lib/v2/engine/db.ts
        │
        ▼
UI surfaces used to spot mismatch
  app/v1/page.tsx, app/v2/page.tsx, app/api/**
```

The screenshot shows a `SCRATCH` on trade #204 with `MAJORITY DOWN (UP 0% / DOWN 04%)` and `direction locked to DOWN` — a plausible symptom surface, so the ledger record for #204 will anchor the trace.

## Investigation stages (evidence-only, no edits)

1. **Enum / mapping census.** Grep every occurrence of `BUY_YES|BUY_NO|YES|NO|UP|DOWN|LONG|SHORT|side|direction|outcome|tokenId|outcomeId|majority|contrarian|invert|opposite` across `lib/v2/engine/**` and `app/**`. Tabulate each mapping (string → enum → boolean → tokenId → CLOB side) and flag any two mappings that disagree.
2. **Majority-side selection.** In `sniper.ts` + `standing-order.ts`, identify the exact function computing majority, the inputs it reads (probability vs bid/ask vs book depth), comparison operators, tie handling, and whether the result is locked for the execution window or recomputed each tick.
3. **Arm → trigger → submit.** Walk `standing-order.ts` from arm to submit: confirm the side stored at arm-time is the side serialized at submit-time; look for retry / cancel-replace paths (`handlers/cancel-replace-pipeline.ts`) that could rebuild an order from stale or recomputed state.
4. **Serialization boundary.** In `execution/paper.ts` (v1) and `execution/live.ts` (v2) verify: internal side → CLOB `BUY/SELL` + `tokenId(YES|NO)` mapping is identical, and that `paper.ts` mirrors `live.ts` exactly (only fills differ). Any divergence between v1 and v2 mapping is itself a defect.
5. **Settlement / replay.** In `settlement-verifier.ts`, `trade-replay.ts`, `report.ts` verify the ledger's `side`/`majority`/`winner` fields are read from the submitted-order record, not recomputed post-hoc (post-hoc recomputation would mask an inversion in the UI while the exchange still received the wrong side, or vice versa).
6. **Replay trade #204** (visible in screenshot) plus 5–10 other historical rows from the SQLite ledger. For each row, emit the pipeline trace: snapshot → signal → confidence → decision → internal enum → serialized payload → exchange ack → settlement. Any stage disagreement is the smoking gun.
7. **Edge cases.** Re-check items 2–5 under: reconnect mid-window, duplicate WS events, out-of-order updates, missing book, trigger hit exactly at window boundary, concurrent markets. Look specifically for shared mutable state (module-level `let`, singletons in `standing-order.ts`) that could bleed one market's side into another.

## Deliverables (evidence report)

- Pipeline diagram (actual, derived from code).
- Enum/mapping table with source lines.
- Per-stage findings with `file:line` citations.
- Replay traces for trade #204 and ≥5 more rows.
- Root cause **or** proof of correctness.
- v1 (PAPER) and v2 (LIVE) impact statements — separate.

## Fix policy (only if a defect is proven)

- Smallest possible change at the identified inversion point.
- Applied symmetrically to v1 and v2 wherever the buggy code is shared or mirrored.
- No refactors, no strategy rewrites, no interface changes.
- Add regression tests under `tests/` covering: majority=YES trigger, majority=NO trigger, boundary confidence, threshold equality (`<` vs `<=`), extreme probabilities, reconnect during window, duplicate WS events, serializer YES/NO → tokenId mapping, replay of a known-good historical trade. Bug is not "fixed" until these pass.

## What I will NOT do

- Assume inversion exists based on the screenshot alone.
- Modify strategy logic, execution architecture, or public interfaces.
- Touch unrelated files.
- Leave temporary instrumentation in production paths.

## Open question before I start executing

Do you want the full evidence report written back into the P4 repo (e.g. `docs/bug-1-direction-investigation.md`) and any fix committed as a patch you apply in GitHub yourself, or do you want me to output findings + patch inline in chat only? This changes nothing about the investigation itself, only how results are delivered.
