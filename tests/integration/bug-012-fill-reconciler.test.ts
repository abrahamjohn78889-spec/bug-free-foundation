/**
 * Bug #012 regression + fill-reconciler contract tests.
 *
 * The fill-reconciler joins CLOB fill events against local ledger rows by
 * exchange order id. This suite pins the four drift classes it must detect
 * across PAPER_V1 and LIVE_V2, and asserts the read-only guarantee (the
 * cross-check kernel is pure — no I/O, no state mutation).
 */
import { describe, it, expect } from "vitest"

import { crossCheck } from "@/lib/v2/engine/fill-reconciler"
import type { SettledTrade, LiveAccountTrade, PipelineMode } from "@/lib/v2/engine/types"

const asFill = (id: string, orderIds: string[], size = 5, price = 0.85): LiveAccountTrade => ({
  id,
  market: "m",
  assetId: "t",
  outcome: "UP",
  side: "BUY",
  price,
  size,
  status: "CONFIRMED",
  traderSide: "MAKER",
  matchTimeMs: Date.now(),
  txHash: null,
  orderIds,
})

const asLedger = (
  id: number,
  orderId: string | null,
  mode: PipelineMode = "PAPER_V1",
  overrides: Partial<SettledTrade> = {},
): SettledTrade => ({
  id,
  marketId: "m",
  slotEndMs: 0,
  side: "UP",
  price: 0.85,
  shares: 5,
  cost: 4.25,
  result: "SCRATCH",
  pnl: 0,
  balanceAfter: 100,
  dustSaved: 0,
  mode,
  createdAt: new Date().toISOString(),
  settledAt: new Date().toISOString(),
  status: "OPEN",
  orderId,
  tradeUid: null,
  entryAtMs: Date.now(),
  markPrice: null,
  unrealizedPnl: null,
  explanation: null,
  ...overrides,
})

describe("fill-reconciler crossCheck — CLOB ↔ ledger", () => {
  for (const mode of ["PAPER_V1", "LIVE_V2"] as const) {
    describe(mode, () => {
      it("clean state: every CLOB fill has a ledger row, no findings", () => {
        const clob = [asFill("t-1", ["eo-1"]), asFill("t-2", ["eo-2"])]
        const ledger = [asLedger(1, "eo-1", mode), asLedger(2, "eo-2", mode)]
        expect(crossCheck(clob, ledger)).toEqual([])
      })

      it("UNBOOKED_FILL: CLOB reports fill, no ledger row (bug #010 signal)", () => {
        const clob = [asFill("t-1", ["eo-dropped"])]
        const findings = crossCheck(clob, [])
        expect(findings).toHaveLength(1)
        expect(findings[0].kind).toBe("UNBOOKED_FILL")
        expect(findings[0].orderId).toBe("eo-dropped")
      })

      it("DUPLICATE_BOOKING: two ledger rows share an orderId (bug #011 guard bypass)", () => {
        const clob = [asFill("t-1", ["eo-dup"])]
        const ledger = [asLedger(1, "eo-dup", mode), asLedger(2, "eo-dup", mode)]
        const findings = crossCheck(clob, ledger)
        expect(findings.some((f) => f.kind === "DUPLICATE_BOOKING" && f.orderId === "eo-dup")).toBe(true)
      })

      it("ORPHAN_LEDGER_ROW: ledger row exists, no CLOB fill (synthesized booking)", () => {
        const ledger = [asLedger(9, "eo-ghost", mode)]
        const findings = crossCheck([], ledger)
        expect(findings).toHaveLength(1)
        expect(findings[0].kind).toBe("ORPHAN_LEDGER_ROW")
        expect(findings[0].orderId).toBe("eo-ghost")
        expect(findings[0].tradeId).toBe(9)
      })

      it("UNATTRIBUTED_FILL: CLOB fill carries no orderId (bug #012 signal)", () => {
        const clob = [asFill("t-orphan", [])]
        const findings = crossCheck(clob, [])
        expect(findings.some((f) => f.kind === "UNATTRIBUTED_FILL")).toBe(true)
      })

      it("failed rollover simulation: cancelled resting order matched, then dropped from ledger", () => {
        // Bug #010 scenario before fix: CLOB reports fill, engine cancelled
        // resting order without booking. The reconciler must surface it.
        const clob = [asFill("t-race", ["eo-race"], 5, 0.85)]
        const ledger: SettledTrade[] = [] // no booking
        const findings = crossCheck(clob, ledger)
        expect(findings).toHaveLength(1)
        expect(findings[0].kind).toBe("UNBOOKED_FILL")
        expect(findings[0].detail).toMatch(/bug #010/i)
      })

      it("retried rollover simulation: duplicate ledger rows for one CLOB fill", () => {
        // Bug #011 scenario before fix: onFill invoked twice, two ledger
        // rows, one CLOB event.
        const clob = [asFill("t-once", ["eo-once"])]
        const ledger = [asLedger(50, "eo-once", mode), asLedger(51, "eo-once", mode)]
        const findings = crossCheck(clob, ledger)
        const dup = findings.find((f) => f.kind === "DUPLICATE_BOOKING")
        expect(dup).toBeDefined()
        expect(dup!.detail).toMatch(/bug #011/i)
      })

      it("crossCheck is pure — same inputs produce identical output twice", () => {
        const clob = [asFill("t-1", ["eo-1"]), asFill("t-2", ["eo-x"])]
        const ledger = [asLedger(1, "eo-1", mode), asLedger(2, "eo-y", mode)]
        const a = crossCheck(clob, ledger)
        const b = crossCheck(clob, ledger)
        expect(a).toEqual(b)
      })
    })
  }
})
