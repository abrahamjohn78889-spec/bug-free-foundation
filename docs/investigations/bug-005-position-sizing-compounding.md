# Bug #5 — Position Sizing, Share Consistency, USD→Shares Conversion & Compounding

Priority: P0. Scope: PAPER_V1 and LIVE_V2 (same seams in `lib/v2/engine/standing-order.ts` and `lib/v2/engine/bankroll.ts`).

## Executive summary

Four related concerns were investigated. Only one is a real defect; the other three are already correct in the current code and either surface intentionally via existing audit paths (partial fill / risk clamp) or reflect exchange constraints (integer shares).

| Concern | Verdict | Root cause |
|---|---|---|
| 1. Variable share size on FIXED_SHARES | **Not a defect** — behavior is intentional and already audited | Partial fills (executor caps `order.shares` to the matched count) and risk-cap `WITHHELD` rows. Both write permanent `order_log` rows and `sizing.partialFill` into the ledger explanation. `this.params.shares` is never mutated. |
| 2. USD → Shares conversion | **Not a defect** | `computeOrderShares` uses `Math.floor(sizeValue / limitPrice)` with the user-configured limit price (never the trigger, never a stale quote). Fractional shares are impossible on Polymarket's CLOB (`orderMinSize=5`, integer share lots), so flooring is mandatory. |
| 3. Share calculation consistency | **Not a defect** | FIXED_SHARES returns `params.shares` verbatim on every call; params are only set inside `arm()` and restored verbatim from persisted state. No code path mutates `params.shares`. |
| 4. Compounding uses stale bankroll | **DEFECT (fixed here)** | `rolloverSlot` fires `void this.settleOfficial(...)` — settlement runs asynchronously. A PERCENT-mode trigger in the new slot could execute before the previous slot's payout was credited to the bankroll, sizing from a stale balance and breaking continuous compounding. |

## Position sizing pipeline (evidence)

```
arm(limitPrice, shares, opts)
    ↓  validates + freezes params { sizingMode, sizeValue, shares, ... }
tick()
    ↓  monitors majority side (see bug #2 window-open lock)
trigger crossed
    ↓  computeOrderShares(limitPrice)
        FIXED_SHARES → params.shares          (never depends on bankroll)
        FIXED_USD    → floor(sizeValue / limitPrice)
        PERCENT      → floor((balance + dust) * pct/100 / limitPrice)
    ↓  risk cap → capped = min(n, maxSharesPerOrder)  (audited if it clamps)
submit LIMIT BUY @ limitPrice for `shares`
    ↓  executor may partial-fill → order.shares reduced to matched count
onFill()
    ↓  bankroll.debitFixed(order.shares × filledPrice)
    ↓  openTrade(...) with sizing + partialFill audit
rolloverSlot()
    ↓  positions handed to settleOfficial (ASYNCHRONOUS)  ← BUG #5 window
recordSettlement() → bankroll.settle(payout) → next slot compounds
```

## Root cause (defect #4)

`lib/v2/engine/standing-order.ts` `rolloverSlot()` (pre-fix):

```ts
const positions = this.positions
this.positions = []
if (positions.length > 0) {
  const fallback = this.computeSpotFallback()
  void this.settleOfficial(positions, fallback)   // async — payout credited LATER
}
```

`settleOfficial` polls Gamma up to `RESOLUTION_ATTEMPTS × RESOLUTION_POLL_MS`. During that window the new slot can re-arm and hit its trigger; `computeOrderShares` in PERCENT mode then reads `bankroll.balance + bankroll.dustReserve` before the previous payout has been credited. Result: order sized from stale money, breaking the "always use the latest settled balance" contract.

FIXED_SHARES and FIXED_USD are unaffected because their size does not depend on bankroll.

## Fix (smallest safe correction)

Track pending-settlement tradeUids on the manager and refuse to size a PERCENT-mode order while any are outstanding.

- `pendingSettlementUids: Set<string>` field on `StandingOrderManager`.
- Add every rollover-handed tradeUid to the set **before** dispatching `settleOfficial`.
- Delete the uid at the top of `recordSettlement` (covers both success and duplicate-suppression paths).
- New status `WAITING_SETTLE`. When PERCENT mode fires with pending settlements, log a `compound-pending-settlement` withhold and return. The next tick re-checks and fires the instant the pool is credited.

No other sizing path is altered. FIXED_SHARES and FIXED_USD keep their exact prior behavior.

## Regression tests

`tests/integration/bug-005-compounding-staleness.test.ts`:

- PERCENT withholds with status `WAITING_SETTLE` while a pending uid is present.
- Gate clears once the pending uid is removed; next PERCENT order fires.
- FIXED_SHARES is NOT gated (independent of bankroll).
- FIXED_SHARES returns the same configured 7 across repeated arms — no silent variance.

Existing coverage in `tests/integration/sizing-and-window.test.ts` already asserts:
- PERCENT sizes from the live pool at fire time.
- FIXED_USD = `floor(usd / limitPrice)`.
- FIXED_SHARES buys exactly the configured count.
- Risk-cap clamp path.

## Files inspected

- `lib/v2/engine/standing-order.ts` (arm, computeOrderShares, onFill, rolloverSlot, recordSettlement, settleOfficial, restoreFromDisk)
- `lib/v2/engine/bankroll.ts` (balance / dust / debitFixed / settle)
- `lib/v2/engine/handlers/dust-compounding.ts`
- `lib/v2/engine/engine.ts` (bankroll reconcile + settlement wiring)
- `lib/v2/engine/settlement-repair.ts`, `settlement-verifier.ts`
- `lib/v2/engine/types.ts` (`StandingOrderStatus`, `SloSizingMode`)
- `tests/integration/sizing-and-window.test.ts`

## PAPER_V1 vs LIVE_V2

Identical. Both modes route through the same `StandingOrderManager` + `Bankroll` seams. The fix is mode-agnostic.

## Risk assessment

- Blast radius: PERCENT sizing only. FIXED_SHARES and FIXED_USD unchanged.
- Failure mode of the fix: over-conservative — if a settlement stalls, the next compounded order is delayed rather than sized wrongly. This is the desired trade-off.
- No schema, ledger, or wire-format changes.

## Recommendation

Ship. The fix is the minimum change that guarantees "next PERCENT order uses the latest settled balance".
