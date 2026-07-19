# INC-004 — Stage 1 (Regression Lock)

## Added
- `tests/helpers/inc-004-chaos-harness.ts` — deterministic `ChaosClock`,
  `FakeClob` (scriptable ACK / REJECTED / LOST_ACK / TIMEOUT / NETWORK_ERROR),
  `mulberry32` PRNG, `makeCoidFactory`.
- `tests/integration/inc-004-order-lifecycle.test.ts` — 11 tests:
  * 7 harness self-tests (all green)
  * 4 contract-lock tests for Stages 2, 3, 4, 5/6 (intentionally red)

## Production code
- Unchanged. Zero imports touched outside `tests/**`.

## Results
- Stage 1 regression suite: 7 passed / 4 failed (as designed).
- Historical suite (excluding `soak*`): 35 files, **405/405 passed**.
