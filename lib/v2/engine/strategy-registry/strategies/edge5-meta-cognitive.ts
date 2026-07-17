import { decide as sniperDecide } from "../../strategy/sniper"
import type { Strategy, StrategyInputs, StrategyParams } from "../types"

// ============================================================
// EDGE 5 — META-COGNITIVE ANALYZER & CASCADING SNIPER ENGINE
//
// The primary, fully-armed execution model. Two protection layers:
//
//  Layer 1 — Early-Candle Reversal Protection
//    Outside the final 20s the sniper returns HOLD/CANCEL, so no
//    payload can fire during the volatile early-candle whip-saw.
//
//  Layer 2 — Dynamic Cascading Priority Sniping Matrix
//    Phase 1 (T-20s..T-11s): cheap liquidity sweep $0.90-$0.94
//    Phase 2 (T-10s..T-3s) : momentum guarantee    $0.95-$0.99
//    Phase 3 (T-2s..T-0s)  : immutable STOPPING lockout
//
// The battle-tested pure decision core lives in strategy/sniper.ts;
// this module is the registry adapter around it.
// ============================================================

export const edge5: Strategy = {
  meta: {
    id: "edge5",
    code: "EDGE 5",
    name: "Meta-Cognitive Cascading Sniper",
    tagline: "Primary time-decay execution model",
    description:
      "Freezes early-candle whip-saws, then cascades resting FOK maker orders through the final 20 seconds — cheap-liquidity sweep first, momentum-guarantee ceiling second, hard STOPPING lockout at T-2s.",
    liveReady: true,
    params: [
      {
        key: "earlyFreeze",
        label: "Early-Candle Freeze",
        kind: "toggle",
        default: true,
        help: "Blocks all execution until the final 20-second cascade window opens.",
      },
      {
        key: "minTimeRemainingS",
        label: "Freeze Until (s remaining)",
        kind: "number",
        min: 20,
        max: 240,
        step: 1,
        unit: "s",
        default: 20,
        help: "No orders route while more than this many seconds remain in the candle.",
      },
    ],
  },

  decide(inputs: StrategyInputs, _params: StrategyParams) {
    // Edge 5 delegates to the proven pure sniper matrix. The engine
    // already derives phase from the NTP clock, so the two protection
    // layers are enforced inside sniperDecide.
    return sniperDecide(inputs)
  },
}
