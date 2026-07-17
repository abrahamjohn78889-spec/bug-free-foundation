import { kvGet, kvSet } from "./db"
import { computeCompounding, type CompoundResult } from "./handlers/dust-compounding"
import type { PipelineMode } from "./types"

// ------------------------------------------------------------
// Full Balance Compounding & Dust Sweep Module
//
//   Shares = Floor((Balance + DustReserve) / Price)
//
// Shares must be whole integers, so the fractional remainder
// ("dust") left after sizing is swept into a persisted reserve
// and rolled forward into the capital pool of the next candle.
// ------------------------------------------------------------

export interface Sizing {
  shares: number
  cost: number
  dust: number
  capitalPool: number
}

export class Bankroll {
  private mode: PipelineMode

  constructor(mode: PipelineMode) {
    this.mode = mode
  }

  private key(suffix: string) {
    return `bankroll:${this.mode}:${suffix}`
  }

  get balance(): number {
    return Number(kvGet(this.key("balance")) ?? 0)
  }

  set balance(v: number) {
    kvSet(this.key("balance"), String(Math.round(v * 10000) / 10000))
  }

  get dustReserve(): number {
    return Number(kvGet(this.key("dust")) ?? 0)
  }

  set dustReserve(v: number) {
    kvSet(this.key("dust"), String(Math.round(v * 10000) / 10000))
  }

  get startingBalance(): number {
    return Number(kvGet(this.key("starting")) ?? 0)
  }

  /** Initialize / reset paper capital (also used by /set_balance) */
  reset(amount: number) {
    this.balance = amount
    this.dustReserve = 0
    kvSet(this.key("starting"), String(amount))
  }

  /**
   * Cumulative compounding sizing. Sweeps prior dust into the pool,
   * floors to whole shares, and computes the new dust remainder.
   */
  size(price: number, minShares: number): Sizing | null {
    // Single source of truth: the dust-compounding handler owns the
    // floor-to-whole-shares + dust-sweep math (5-share minimum guard).
    const result: CompoundResult | null = computeCompounding(this.balance, this.dustReserve, price, minShares)
    return result
  }

  /** Commit a fill: capital pool minus cost becomes the dust reserve. */
  commitFill(sizing: Sizing) {
    this.balance = 0
    this.dustReserve = sizing.dust
  }

  /**
   * Fixed-size debit for a Standing Limit Order fill. Unlike the
   * compounding all-in model (`commitFill`), the SLO buys an exact,
   * user-specified share count, so we simply deduct its cost from the
   * pool (balance first, then dust). Independent of the strategy path.
   */
  debitFixed(cost: number) {
    const rounded = Math.round(cost * 10000) / 10000
    const fromBalance = Math.min(this.balance, rounded)
    this.balance = Math.round((this.balance - fromBalance) * 10000) / 10000
    const remainder = rounded - fromBalance
    if (remainder > 0) {
      this.dustReserve = Math.max(0, Math.round((this.dustReserve - remainder) * 10000) / 10000)
    }
  }

  /** Settle a candle: payout returns to the balance for the next slot.
   *  Rounded to 4dp like every other mutator — an unrounded float add here
   *  was a slow drift source that tripped the accounting invariants. */
  settle(payout: number) {
    this.balance = Math.round((this.balance + payout) * 10000) / 10000
  }
}
