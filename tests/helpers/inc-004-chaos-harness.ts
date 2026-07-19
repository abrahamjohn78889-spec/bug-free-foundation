/**
 * INC-004 Stage 1 — Deterministic Chaos Harness
 *
 * Purpose: provide test-only primitives to drive the order-submission
 * pipeline through every failure mode we care about, without touching
 * production code. Later stages (2–6) wire real modules into this harness.
 *
 * Determinism guarantees:
 *   - No real time: all delays are driven by ChaosClock.advance().
 *   - No real randomness: all "random" choices come from an injected seed
 *     via a Mulberry32 PRNG.
 *   - No I/O: FakeClob is pure in-memory.
 *
 * This file MUST NOT import from lib/v2/engine/execution/* — Stage 1 is a
 * regression lock only. The harness is imported by the Stage 1 regression
 * test file (tests/integration/inc-004-order-lifecycle.test.ts).
 */

export type ClobOutcome =
  | { kind: "ACK"; exchangeOrderId: string }
  | { kind: "REJECTED"; reason: string }
  | { kind: "LOST_ACK"; exchangeOrderId: string } // exchange accepted, client never saw the ack
  | { kind: "TIMEOUT" }
  | { kind: "NETWORK_ERROR"; reason: string };

export interface SubmitRequest {
  clientOrderId: string;
  marketId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
}

export interface SubmitAttemptRecord {
  attempt: number;
  clientOrderId: string;
  outcome: ClobOutcome;
  tSubmitMs: number;
  tResolveMs: number;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (Mulberry32). Small, well-known, no deps.
// ---------------------------------------------------------------------------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// ChaosClock — virtual time. Supports advance() and scheduled callbacks.
// ---------------------------------------------------------------------------
interface ScheduledCallback {
  atMs: number;
  cb: () => void;
  id: number;
}

export class ChaosClock {
  private tMs = 0;
  private queue: ScheduledCallback[] = [];
  private nextId = 1;

  now(): number {
    return this.tMs;
  }

  setTimeout(cb: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.queue.push({ atMs: this.tMs + Math.max(0, delayMs), cb, id });
    this.queue.sort((a, b) => a.atMs - b.atMs || a.id - b.id);
    return id;
  }

  clearTimeout(id: number): void {
    this.queue = this.queue.filter((q) => q.id !== id);
  }

  /** Advance virtual time by deltaMs, firing any callbacks whose deadline elapses. */
  advance(deltaMs: number): void {
    if (deltaMs < 0) throw new Error("ChaosClock.advance: deltaMs must be >= 0");
    const target = this.tMs + deltaMs;
    while (this.queue.length && this.queue[0].atMs <= target) {
      const next = this.queue.shift()!;
      this.tMs = next.atMs;
      next.cb();
    }
    this.tMs = target;
  }

  /** Deterministic sleep primitive for async code under test. */
  sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeout(resolve, delayMs);
    });
  }
}

// ---------------------------------------------------------------------------
// FakeClob — scriptable exchange stub.
// ---------------------------------------------------------------------------

/** A scripted response for the next N submit calls. */
export type ScriptedResponse = {
  latencyMs: number;
  outcome: ClobOutcome;
};

export interface FakeClobOptions {
  clock: ChaosClock;
  /** Fixed exchange-side id prefix, so id generation is deterministic. */
  exchangeIdPrefix?: string;
}

export class FakeClob {
  private clock: ChaosClock;
  private script: ScriptedResponse[] = [];
  private defaultResponse: ScriptedResponse = {
    latencyMs: 5,
    outcome: { kind: "ACK", exchangeOrderId: "" },
  };
  private attempts: SubmitAttemptRecord[] = [];
  private submitCount = 0;
  private exchangeIdPrefix: string;
  private exchangeIdSeq = 0;
  /** Exchange-side ledger of orders it has accepted, keyed by exchangeOrderId. */
  private accepted = new Map<string, SubmitRequest>();
  /** Reverse index: coid → list of exchange orders accepted for that coid. */
  private byCoid = new Map<string, string[]>();

  constructor(opts: FakeClobOptions) {
    this.clock = opts.clock;
    this.exchangeIdPrefix = opts.exchangeIdPrefix ?? "exch_";
  }

  /** Queue a scripted response consumed by the next submit() call. */
  scriptNext(response: ScriptedResponse): void {
    this.script.push(response);
  }

  scriptMany(responses: ScriptedResponse[]): void {
    for (const r of responses) this.script.push(r);
  }

  /** Response used once the scripted queue is exhausted. */
  setDefault(response: ScriptedResponse): void {
    this.defaultResponse = response;
  }

  getAttempts(): ReadonlyArray<SubmitAttemptRecord> {
    return this.attempts;
  }

  getAcceptedOrders(): ReadonlyMap<string, SubmitRequest> {
    return this.accepted;
  }

  getAcceptedByCoid(coid: string): ReadonlyArray<string> {
    return this.byCoid.get(coid) ?? [];
  }

  private nextExchangeId(): string {
    this.exchangeIdSeq += 1;
    return `${this.exchangeIdPrefix}${this.exchangeIdSeq}`;
  }

  /**
   * Submit an order. Resolves after `latencyMs` virtual time has elapsed.
   * The caller (or the test) is responsible for advancing the clock.
   */
  submit(req: SubmitRequest): Promise<ClobOutcome> {
    this.submitCount += 1;
    const attempt = this.submitCount;
    const tSubmitMs = this.clock.now();
    const scripted = this.script.shift() ?? this.defaultResponse;

    // Materialise a concrete outcome so every attempt gets a unique
    // exchange id when the outcome type demands one.
    let outcome: ClobOutcome = scripted.outcome;
    if (outcome.kind === "ACK" || outcome.kind === "LOST_ACK") {
      const exchangeOrderId = outcome.exchangeOrderId || this.nextExchangeId();
      outcome = { ...outcome, exchangeOrderId };
      // Both ACK and LOST_ACK mean the exchange accepted the order.
      this.accepted.set(exchangeOrderId, { ...req });
      const list = this.byCoid.get(req.clientOrderId) ?? [];
      list.push(exchangeOrderId);
      this.byCoid.set(req.clientOrderId, list);
    }

    return new Promise<ClobOutcome>((resolve, reject) => {
      this.clock.setTimeout(() => {
        this.attempts.push({
          attempt,
          clientOrderId: req.clientOrderId,
          outcome,
          tSubmitMs,
          tResolveMs: this.clock.now(),
        });
        if (outcome.kind === "TIMEOUT") {
          reject(new Error("TIMEOUT"));
        } else if (outcome.kind === "NETWORK_ERROR") {
          reject(new Error(`NETWORK_ERROR: ${outcome.reason}`));
        } else if (outcome.kind === "LOST_ACK") {
          // The exchange accepted, but the ack never reaches the client.
          // Model this as an error on the client side.
          reject(new Error("LOST_ACK"));
        } else {
          resolve(outcome);
        }
      }, scripted.latencyMs);
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers: stable coid factory for use inside tests.
// ---------------------------------------------------------------------------
export function makeCoidFactory(prefix = "coid_"): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${n}`;
  };
}
