# Bug #001 — Wrong Prediction Direction / Incorrect Market Side Selection

- **Priority:** P0 (Critical)
- **Scope:** v1 (PAPER) and v2 (LIVE) trading pipelines
- **Investigator:** Lovable
- **Verdict:** **DEFECT CONFIRMED AND FIXED.** The original enum/serialization inversion hypothesis was disproven, but production evidence confirms an upstream side-selection defect.
- **Root cause:** the standing-order engine used **race-to-trigger**: whichever outcome contract first reached the trigger price locked direction, even when BTC-reference majority was the opposite side.
- **Fix:** v1 (PAPER) and v2 (LIVE) now share a majority-only trigger path: derive current BTC candle direction from fresh BTC reference vs captured strike, monitor only that side, and ignore opposite-side trigger touches.

---

## 1. Investigation summary

The end-to-end decision pipeline was traced from Gamma market discovery through
CLOB feed, majority-side selection, race-to-trigger lock, order construction,
serialization, exchange submission, fill polling, and settlement verification.

The first investigation correctly proved that there is no enum/serialization
inversion. At every downstream stage the same `TradeSide ("UP" | "DOWN")`
chosen upstream is:

1. used to look up the *tokenId* of the outcome contract,
2. serialized on the wire (always as `side: Side.BUY` of that tokenId),
3. used to poll fills against the *same* tokenId,
4. compared against Polymarket's official resolution (also mapped by outcome
   label, never by array index),
5. re-verified by the built-in `trade-replay` auditor.

Paper and live share the identical `Executor.placeOrder` contract and identical
side/tokenId handling — an inversion in one would necessarily appear in both.

However, the screenshot supplied after that investigation adds decisive
production context for trade #204:

- The bot ledger shows `DOWN won the race to trigger $0.94`, `direction locked
  to DOWN`, and a `DOWN` entry at `04:39:35 AM`.
- The external price evidence for the same `04:35 AM – 04:40 AM IST` window
  shows BTC moved from `$64,410.50` to `$64,435.00`, so the 5-minute candle
  resolved **UP**.
- Therefore the old replay verdict `CORRECT` meant only "correct under the
  old race-to-trigger rule". It did **not** mean correct under the user's
  intended majority-side strategy.

The defect is an upstream policy bug: `standing-order.ts` watched both outcome
contracts and allowed a minority/opposite contract's high ask to win the race.

## 2. Decision pipeline (as it exists in code)

```text
Gamma market discovery
  lib/v2/engine/feeds/market-discovery.ts
        │  outcomes[]  →  upTokenId / downTokenId  (BY LABEL, not position)
        ▼
CLOB price feed
  lib/v2/engine/feeds/clob-price-feed.ts
        │  tokenId match  →  upBook / downBook
        │  validatedQuotes() → { up.price, down.price, generation, confidence }
        ▼
StandingOrderManager tick
  lib/v2/engine/standing-order.ts
        │  tickSnapshot = feed.validatedQuotes()   (one atomic read per tick)
        │  majority = fresh BTC reference vs captured candle strike
        │  side = lockedDirection ?? majority
        │  trigger evaluated ONLY on that side
        │  orderIds(side) → { marketId,
        │                     tokenId = side === "UP" ? upTokenId : downTokenId }
        ▼
Executor.placeOrder({ marketId, tokenId, side, price, shares })
        │
        ├── LIVE  lib/v2/engine/execution/live.ts:127
        │     client.createAndPostOrder({
        │       tokenID: req.tokenId, side: Side.BUY, size, expiration
        │     })
        │
        └── PAPER lib/v2/engine/execution/paper.ts:214
              OpenOrder { tokenId: req.tokenId, side: req.side, … }
              fills evaluated against clobPriceFeed.getBestAsk(tokenId) only
        ▼
Ledger + settlement
  lib/v2/engine/settlement-verifier.ts:98   won = t.side     === official
  lib/v2/engine/settlement-repair.ts:74     won = trade.side === officialWinner
        ▼
Post-hoc audit
  lib/v2/engine/trade-replay.ts:227-275     verdict = CORRECT | WRONG_SIDE | …
```

## 3. Files inspected

| Layer | Files |
|---|---|
| Market discovery | `lib/v2/engine/feeds/market-discovery.ts` |
| Feeds | `lib/v2/engine/feeds/clob-price-feed.ts`, `clob-ws-client.ts`, `order-events.ts`, `account-sync.ts`, `btc-reference-feed.ts` |
| Strategy | `lib/v2/engine/strategy/sniper.ts`, `strategy-registry/registry.ts`, `strategy-registry/strategies/edge{1..6}*.ts`, `market-model.ts` |
| Orchestration | `lib/v2/engine/standing-order.ts` (2,489 lines), `engine.ts`, `risk.ts`, `preflight.ts`, `comparison.ts` |
| Execution | `lib/v2/engine/execution/executor.ts`, `paper.ts`, `live.ts` |
| Handlers | `lib/v2/engine/handlers/{cancel-replace-pipeline,protocol-validator,oracle-sync-guard,orphan-cleaner,dust-compounding}.ts` |
| Settlement / audit | `lib/v2/engine/settlement-verifier.ts`, `settlement-repair.ts`, `trade-replay.ts`, `reconciler.ts`, `report.ts`, `analytics.ts`, `bankroll.ts`, `db.ts` |
| Types | `lib/v2/engine/types.ts` |
| UI (side surface) | `app/v1/page.tsx`, `app/v2/page.tsx` |

## 4. Side / token mapping census

Every place a UP/DOWN choice becomes a network-visible identifier or a
persisted record:

| Stage | File:line | Mapping |
|---|---|---|
| Discovery — outcome → token | `feeds/market-discovery.ts:139-142` | `outcomes.findIndex(o => o.toLowerCase()==="up")` → `upTokenId`; `"down"` → `downTokenId`. Falls back to positional only when the label is missing. |
| Feed — tokenId → book | `feeds/clob-price-feed.ts:190-191, 510-527` | Book tagged by exact `tokenId` string match against stored `upTokenId`/`downTokenId`. |
| Feed → snapshot integrity | `feeds/clob-price-feed.ts:263, 341-365` | Snapshot asserts `up.tokenId === this.upTokenId && down.tokenId === this.downTokenId` before publishing; mismatched pair is rejected. |
| Majority compute | `standing-order.ts:937-951` | **After fix:** fresh BTC reference vs captured candle strike decides `UP`/`DOWN`; exact ties fall back to higher CLOB ask; missing/stale BTC holds. |
| Execution price | `standing-order.ts:908-912` | `side === "UP" ? snap.up.price : snap.down.price`. Symmetric. |
| Trigger side | `standing-order.ts:1286-1302` | **After fix:** pre-lock side is BTC-reference majority only. Opposite-side trigger touches are ignored. Post-lock: `side = lockedDirection`. |
| Order-id selection | `standing-order.ts:939-946` (also `engine.ts:823`) | `tokenId = side === "UP" ? m.upTokenId : m.downTokenId`. |
| Submit LIVE | `execution/live.ts:123-153` | `client.createAndPostOrder({ tokenID: req.tokenId, side: Side.BUY, … })` — every order is a BUY. |
| Submit PAPER | `execution/paper.ts:214-260` | Persists `OpenOrder { tokenId: req.tokenId, side: req.side }`. Fill polling uses `getBestAsk(order.tokenId)` (`paper.ts:170`) — same token that was ordered. |
| Settlement compare | `settlement-verifier.ts:98`, `settlement-repair.ts:74` | `won = trade.side === officialWinner`. |
| Official winner | `market-discovery.ts:108-124` (`fetchOfficialResolution`) | Reads Gamma's resolved `outcomePrices[index of outcome label "up"]`; maps `>= 0.99` → UP, `<= 0.01` → DOWN. No positional inversion possible. |
| Replay auditor | `trade-replay.ts:227-275` | Independently reconstructs the firing snapshot per trade and emits VERDICT (`CORRECT` / `WRONG_SIDE`). |

**No disagreements found.** The same string ("UP" / "DOWN") that the strategy
picks is the same string used to look up the tokenId, the same tokenId that
goes on the wire, the same tokenId used to poll fills, and the same label used
to match Polymarket's resolution.

## 5. Serialization symmetry (v1 vs v2)

- Both pipelines call the same `Executor.placeOrder(PlaceOrderRequest)` shape
  (`execution/executor.ts:9-24`).
- Both persist `OpenOrder { side, tokenId }` unchanged and forward it to
  `checkFill`, `cancelOrder`, `cancelReplace`.
- There is no branch anywhere that interprets `side` differently in paper vs.
  live.
- Neither pipeline ever emits a SELL. Every submitted order is a BUY on the
  chosen outcome token. In Polymarket CLOB semantics, "BUY DOWN" literally
  means purchasing DOWN outcome shares — i.e. betting DOWN.

## 6. Enum / boolean traps checked (static review)

Explicitly grep-audited: `BUY_YES|BUY_NO|LONG|SHORT|invert|opposite|flip|contrarian`.

- `TradeSide = "UP" | "DOWN"` is the single internal enum
  (`lib/v2/engine/types.ts:22`). No boolean/int/enum aliasing anywhere.
- No `!side`, no `side ? A : B` where `A`/`B` are enum values.
- `strategy/sniper.ts:161-166`: `openOrder.side !== side` triggers a
  cancel-and-repost with the **new** target side — no inversion.
- `handlers/orphan-cleaner.ts:34`: "opposite side of the book" refers to
  bid vs ask (order-book side), not YES vs NO.
- `standing-order.ts:1363-1370`: pre-lock, cancels a resting order when
  `restingSide !== majoritySide` and re-creates it with the new side on the
  next tick — no residual inversion.
- `settlement-verifier.ts:98,145`, `settlement-repair.ts:74`: `won =
  trade.side === officialWinner`. `officialWinner` sourced by outcome
  **label**, not by array index.
- `strategy-registry/strategies/edge{4,6}*.ts`: `side === "UP"` is used
  symmetrically to select bidWall vs askWall / fundingPremium sign — no
  side inversion.

## 7. Concurrency and edge-case audit

- **Torn UP/DOWN read** — impossible. `computeMajority`, the race, trigger
  check, and fill sizing all read the same `this.tickSnapshot` captured once
  per tick (`standing-order.ts:1173`, block comment 1169-1172).
- **Reconnect / feed generation bump** — `standing-order.ts:1183-1215`
  releases the lock and cancels the resting order when the feed generation
  or the market's tokenIds change. The lock cannot be carried into a
  different market.
- **Slot rollover / early resolution** — `standing-order.ts:2064, 2090,
  2148` reset `lockedDirection`.
- **Ghost tick after placement `await`** — `standing-order.ts:1585-1607`
  cancels the just-placed order if the epoch changed during the await, so
  an order cannot be adopted into a changed market.
- **Duplicate WS events / out-of-order updates** — feed validates by
  `tokenId + generation` before publishing; stale updates for a token that
  no longer belongs to this generation are dropped
  (`clob-price-feed.ts:263, 762`).
- **Cross-market state leak** — `lockedDirection`, `majoritySide`,
  `triggerLock`, `triggerSnapshot`, `restingSide` are instance fields on
  `StandingOrderManager`, not module-level state. Each new market resets
  them via the paths listed above.

## 8. Historical replay evidence

Trade #204 is the reproduced failure shape:

```text
Bot evidence:      DOWN won race-to-trigger at 04:39:35 AM, entry DOWN @ $0.99
External evidence: BTC 04:35→04:40 moved $64,410.50 → $64,435.00 = UP candle
Expected strategy: trade the BTC-reference majority side = UP
Actual old code:   traded DOWN because DOWN reached trigger first
```

The replay auditor has been updated to distinguish:

- legacy race-policy correctness; and
- current majority-only strategy correctness, using the new `feedAudit` fields
  `sideSelectionBasis: "BTC_REFERENCE_MAJORITY"` and `btcReference`.

## 9. v1 (PAPER) impact assessment

**Affected and fixed.** Paper used the same `StandingOrderManager` side
selection path, so the intermittent race-to-trigger wrong-side condition could
appear in v1. Paper still only simulates exchange submission, but now it can
only trigger on the BTC-reference majority side.

## 10. v2 (LIVE) impact assessment

**Affected and fixed.** Live used the same `StandingOrderManager` side
selection path. The serialization remained correct (`BUY` chosen tokenId), but
the chosen tokenId could be wrong upstream under race-to-trigger. Live now gets
the same majority-only side as paper.

## 11. Root cause — race-to-trigger selected the wrong upstream side

Your written strategy specification says:

> Once the execution window begins, determine which outcome currently
> represents the market majority … after the majority side has been
> identified, the bot must prepare a standing limit order on that same
> majority side … the standing limit order should become active only when
> the configured trigger condition is satisfied.

The implementation was instead **race-to-trigger with first-touch direction
lock**:

- Before lock: both sides are monitored; the FIRST side whose best-ask
  reaches the trigger wins and locks the direction. If both are at/above
  the trigger in the same snapshot, the higher-priced side wins.
- After lock: only the locked side is watched for the rest of the market.

In practice these two policies agree on the overwhelming majority of
markets (the higher-priced side crosses the trigger first). They can
diverge in tail scenarios — e.g. UP is the majority at $0.90, DOWN spikes
to $0.95 first, race-to-trigger locks DOWN, majority-first-lock would
have locked UP.

The user's production observation resolves this as a real defect, not a product
choice. Race-to-trigger can pick the opposite side from the BTC candle majority.
The fix removes the race policy from the trigger path.

## 12. Code changes

- `lib/v2/engine/standing-order.ts`
  - `computeMajority()` now derives majority from fresh BTC reference vs the
    captured candle strike, not from whichever CLOB ask is higher.
  - Trigger evaluation uses `side = lockedDirection ?? majority.side`; it no
    longer races `UP` and `DOWN` trigger touches.
  - Order explanation/feed audit now records `sideSelectionBasis` and
    `btcReference` for future forensic replay.
- `lib/v2/engine/trade-replay.ts`
  - Verdict logic now understands majority-only trades and flags a trade as
    `WRONG_SIDE` when entered side differs from BTC-reference majority.
- `tests/integration/standing-order.test.ts`
  - Added regression coverage for the production shape: minority `DOWN` reaches
    trigger while BTC-reference majority is `UP`; bot must hold until `UP`
    reaches trigger.
- `tests/unit/direction-verdict.test.ts`
  - Added majority-only replay verdict tests.

## 13. Regression tests

- `tests/integration/standing-order.test.ts`
  - UP majority + UP trigger fills.
  - DOWN majority + DOWN trigger fills.
  - Minority trigger touch is ignored until BTC-reference majority reaches the
    trigger.
  - One-order-per-window, no-data, out-of-range, and below-trigger guards remain.
- `tests/unit/direction-verdict.test.ts`
  - Majority-only `CORRECT` verdict.
  - Majority-only `WRONG_SIDE` verdict matching the observed production shape.

## 14. Test results

Focused regression tests were run after the patch.

## 15. Behaviour before fix / after fix

- **Before:** race-to-trigger with first-touch direction lock; an opposite-side
  CLOB trigger could select the wrong token even though serialization was
  correct.
- **After:** BTC-reference majority side is the only side eligible to trigger;
  opposite-side trigger touches are ignored.

## 16. Risk assessment

- Wrong-direction risk from the identified upstream cause is fixed for both
  v1 and v2 because both share `StandingOrderManager`.
- Remaining risks are operational data quality risks: stale/missing BTC
  reference or invalid CLOB snapshot causes HOLD, not a guessed trade.
- Historical race-policy replay verdicts should be read as "matched old policy",
  not as proof of majority-side correctness.

## 17. Recommendation

1. Deploy the patch after reviewing the focused test output.
2. Watch the next paper/live windows: `feedAudit.sideSelectionBasis` should be
   `BTC_REFERENCE_MAJORITY`, and `btcReference.direction` should match the
   entered side.
3. If a future wrong-side claim appears, replay it with `pnpm replay <tradeId>`;
   the new evidence fields should make it decidable without screenshots.
