# Changelog

All notable changes to P4 are documented here.

## [Unreleased]

### Investigations

- **Bug #001 — Wrong Prediction Direction / Incorrect Market Side Selection (P0).**
  Full end-to-end trace of the decision pipeline from Gamma market discovery
  through CLOB feed, majority-side selection, lock timing, trigger logic,
  execution-window state, serialization, exchange submission, fill polling and
  settlement verification. **Verdict: defect confirmed upstream of
  serialization and fixed in both v1 (PAPER) and v2 (LIVE).** Report:
  `docs/investigations/bug-001-wrong-direction.md`.

### Fixed

- **Standing limit direction selection:** replaced race-to-trigger side
  selection with BTC-reference majority-only trigger selection. The bot now
  monitors only the majority side (fresh BTC reference vs captured candle
  strike) and ignores opposite-side trigger touches. Added forensic audit fields
  and regression tests for the observed production failure shape.
