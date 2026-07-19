/**
 * INC-004 Stage 3 — ClobAdapter
 *
 * Isolated, side-effect-free abstraction over a CLOB submission client.
 *
 * Contract:
 *   - Adapter NEVER throws. Every outcome is returned as a structured
 *     SubmissionResult so callers can drive intent-lifecycle transitions
 *     deterministically (wired in Stage 4).
 *   - Retries reuse a STABLE client_order_id: retrying the same submit
 *     never derives a new coid. This is the pre-condition for exchange-side
 *     dedupe and for reconciler adoption in Stage 5.
 *   - Backoff is deterministic: base * 2^(attempt-1), capped, with optional
 *     jitter driven by an INJECTED PRNG (never Math.random).
 *   - No database writes. No feature flags. No live wiring. Stage 3 is a
 *     unit-testable module; Stage 4 threads it through the engine.
 */

// ---------------------------------------------------------------------------
// Public API — types
// ---------------------------------------------------------------------------

export interface OrderIntentInput {
  /**
   * Stable local intent id. The adapter derives client_order_id from this.
   * Retries for the same intent MUST reuse the same intentId so the coid
   * is stable across attempts.
   */
  intentId: string;
  marketId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
}

/** Terminal classification of a single submission attempt outcome. */
export enum SubmissionStatus {
  /** Exchange acknowledged and returned an exchange order id. */
  ACCEPTED = "ACCEPTED",
  /** Exchange rejected for a permanent, non-retryable reason. */
  REJECTED = "REJECTED",
  /**
   * Client saw a network/timeout/lost-ack failure. Exchange state is
   * UNKNOWN — the order may or may not exist upstream. Reconciler
   * (Stage 5) resolves via coid lookup.
   */
  AMBIGUOUS = "AMBIGUOUS",
  /** Retry budget exhausted with only retryable failures. Same as AMBIGUOUS
   *  from an exchange-state perspective, but flagged so callers can alert. */
  RETRIES_EXHAUSTED = "RETRIES_EXHAUSTED",
}

export type SubmissionErrorClass =
  | "NONE"
  | "REJECTED_PERMANENT"
  | "TIMEOUT"
  | "NETWORK"
  | "LOST_ACK"
  | "UNKNOWN";

export interface SubmissionAttempt {
  attempt: number;
  tStartMs: number;
  tEndMs: number;
  errorClass: SubmissionErrorClass;
  errorMessage?: string;
  /** Set when the underlying exchange call surfaced an exchange order id
   *  even though the client-side outcome was a failure (LOST_ACK). */
  observedExchangeOrderId?: string;
}

export interface SubmissionResult {
  status: SubmissionStatus;
  clientOrderId: string;
  intentId: string;
  /** Populated on ACCEPTED. May also be populated on AMBIGUOUS when the
   *  underlying transport surfaced an id despite the client-side failure. */
  exchangeOrderId?: string;
  /** Only set on REJECTED. */
  rejectReason?: string;
  attempts: SubmissionAttempt[];
  /** True whenever the exchange MAY hold an order for this coid that the
   *  client cannot confirm — i.e. any AMBIGUOUS/RETRIES_EXHAUSTED path
   *  where a prior attempt could have landed upstream. */
  requiresReconciliation: boolean;
}

/**
 * The transport-level surface the adapter depends on. FakeClob (harness)
 * and the real Polymarket client both satisfy this shape; the adapter is
 * agnostic to which one is wired.
 */
export interface ClobSubmitRequest {
  clientOrderId: string;
  marketId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
}

export type ClobRawOutcome =
  | { kind: "ACK"; exchangeOrderId: string }
  | { kind: "REJECTED"; reason: string };

export interface ClobLike {
  /**
   * Submit an order. Success paths resolve with an ACK or REJECTED outcome.
   * Failure paths (timeouts, network errors, lost acks) MUST reject the
   * promise; the adapter classifies the error via `classifyError`.
   */
  submit(req: ClobSubmitRequest): Promise<ClobRawOutcome>;
}

export interface ClockLike {
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

export interface ClobAdapterOptions {
  clob: ClobLike;
  clock: ClockLike;
  /** Deterministic PRNG in [0,1). Required when jitter is enabled. */
  rng?: () => number;
  /** Prefix included in every derived client_order_id. */
  coidPrefix?: string;
  /** Max attempts including the initial one. Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms. Default 100. */
  backoffBaseMs?: number;
  /** Cap for a single backoff sleep. Default 5_000. */
  backoffCapMs?: number;
  /** Multiplicative jitter fraction in [0,1]. 0 disables jitter. Default 0.2. */
  jitter?: number;
  /** Per-attempt timeout in ms. 0 disables. Default 5_000. */
  perAttemptTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Public API — helpers
// ---------------------------------------------------------------------------

/**
 * Derive a stable client_order_id from an intent id. Pure function — the
 * same intentId always yields the same coid, which is the ONLY correct
 * behaviour for retry safety.
 */
export function deriveClientOrderId(intentId: string, prefix = "coid_"): string {
  if (!intentId || typeof intentId !== "string") {
    throw new Error("deriveClientOrderId: intentId must be a non-empty string");
  }
  return `${prefix}${intentId}`;
}

/**
 * Classify a raw error thrown by a ClobLike.submit() rejection into a
 * stable SubmissionErrorClass. Lives at module scope so callers can use
 * the same taxonomy without instantiating the adapter.
 */
export function classifyError(err: unknown): SubmissionErrorClass {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/timeout/i.test(msg)) return "TIMEOUT";
  if (/lost_ack/i.test(msg)) return "LOST_ACK";
  if (/network|econn|socket|fetch|dns|epipe|reset/i.test(msg)) return "NETWORK";
  return "UNKNOWN";
}

/** True when the error class is safe to retry with the SAME coid. */
export function isRetryable(cls: SubmissionErrorClass): boolean {
  return cls === "TIMEOUT" || cls === "NETWORK" || cls === "LOST_ACK";
}

/**
 * Extract an exchange order id from an error object if the transport
 * layer chose to attach one (e.g. LOST_ACK carrying the id the exchange
 * assigned). Never throws.
 */
export function extractExchangeIdFromError(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const anyErr = err as Record<string, unknown>;
  const id = anyErr.exchangeOrderId ?? anyErr.exchange_order_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Deterministic backoff. Exposed for tests.
 *   delay = min(base * 2^(attempt-1), cap)
 *   jittered = delay * (1 + jitter * (2*rng() - 1))  (rng ∈ [0,1))
 * Result is clamped to [0, cap].
 */
export function computeBackoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  jitter: number,
  rng: () => number,
): number {
  if (attempt < 1) return 0;
  const pow = Math.min(30, attempt - 1);
  const raw = Math.min(capMs, baseMs * Math.pow(2, pow));
  if (jitter <= 0) return raw;
  const factor = 1 + jitter * (2 * rng() - 1);
  const jittered = raw * factor;
  return Math.max(0, Math.min(capMs, jittered));
}

// ---------------------------------------------------------------------------
// ClobAdapter
// ---------------------------------------------------------------------------

export class ClobAdapter {
  private readonly clob: ClobLike;
  private readonly clock: ClockLike;
  private readonly rng: () => number;
  private readonly coidPrefix: string;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly jitter: number;
  private readonly perAttemptTimeoutMs: number;

  constructor(opts: ClobAdapterOptions) {
    this.clob = opts.clob;
    this.clock = opts.clock;
    this.rng = opts.rng ?? (() => 0.5);
    this.coidPrefix = opts.coidPrefix ?? "coid_";
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.backoffBaseMs = Math.max(0, opts.backoffBaseMs ?? 100);
    this.backoffCapMs = Math.max(0, opts.backoffCapMs ?? 5_000);
    this.jitter = Math.min(1, Math.max(0, opts.jitter ?? 0.2));
    this.perAttemptTimeoutMs = Math.max(0, opts.perAttemptTimeoutMs ?? 5_000);
  }

  /**
   * Submit an intent with deterministic retry. Never throws.
   */
  async submit(intent: OrderIntentInput): Promise<SubmissionResult> {
    const clientOrderId = deriveClientOrderId(intent.intentId, this.coidPrefix);
    const attempts: SubmissionAttempt[] = [];
    let observedExchangeOrderId: string | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const tStartMs = this.clock.now();
      let outcome: ClobRawOutcome | undefined;
      let errorClass: SubmissionErrorClass = "NONE";
      let errorMessage: string | undefined;
      let attemptExchangeId: string | undefined;

      try {
        outcome = await this.runWithTimeout({
          clientOrderId,
          marketId: intent.marketId,
          side: intent.side,
          price: intent.price,
          size: intent.size,
        });
      } catch (err) {
        errorClass = classifyError(err);
        errorMessage = err instanceof Error ? err.message : String(err ?? "");
        attemptExchangeId = extractExchangeIdFromError(err);
        if (attemptExchangeId) observedExchangeOrderId = attemptExchangeId;
      }

      const tEndMs = this.clock.now();
      attempts.push({
        attempt,
        tStartMs,
        tEndMs,
        errorClass,
        errorMessage,
        observedExchangeOrderId: attemptExchangeId,
      });

      if (outcome) {
        if (outcome.kind === "ACK") {
          return {
            status: SubmissionStatus.ACCEPTED,
            clientOrderId,
            intentId: intent.intentId,
            exchangeOrderId: outcome.exchangeOrderId,
            attempts,
            requiresReconciliation: false,
          };
        }
        // REJECTED — permanent, do not retry.
        attempts[attempts.length - 1].errorClass = "REJECTED_PERMANENT";
        return {
          status: SubmissionStatus.REJECTED,
          clientOrderId,
          intentId: intent.intentId,
          rejectReason: outcome.reason,
          attempts,
          // Reject means exchange definitively did not accept THIS attempt.
          // Earlier LOST_ACK on the same coid still requires reconciliation.
          requiresReconciliation: observedExchangeOrderId !== undefined,
          exchangeOrderId: observedExchangeOrderId,
        };
      }

      if (!isRetryable(errorClass) || attempt === this.maxAttempts) break;

      const delay = computeBackoffMs(
        attempt,
        this.backoffBaseMs,
        this.backoffCapMs,
        this.jitter,
        this.rng,
      );
      if (delay > 0) await this.clock.sleep(delay);
    }

    const last = attempts[attempts.length - 1];
    const exhausted = attempts.length >= this.maxAttempts && isRetryable(last.errorClass);
    return {
      status: exhausted ? SubmissionStatus.RETRIES_EXHAUSTED : SubmissionStatus.AMBIGUOUS,
      clientOrderId,
      intentId: intent.intentId,
      exchangeOrderId: observedExchangeOrderId,
      attempts,
      // Any retryable failure MAY have landed at the exchange; reconciler
      // must confirm via coid lookup before the intent is finalised.
      requiresReconciliation: true,
    };
  }

  private runWithTimeout(req: ClobSubmitRequest): Promise<ClobRawOutcome> {
    if (this.perAttemptTimeoutMs <= 0) return this.clob.submit(req);
    return new Promise<ClobRawOutcome>((resolve, reject) => {
      let settled = false;
      const timer = this.clock.sleep(this.perAttemptTimeoutMs).then(() => {
        if (settled) return;
        settled = true;
        reject(new Error("TIMEOUT"));
      });
      this.clob.submit(req).then(
        (v) => {
          if (settled) return;
          settled = true;
          resolve(v);
        },
        (e) => {
          if (settled) return;
          settled = true;
          reject(e);
        },
      );
      // Silence unhandled-rejection potential on the timer promise.
      void timer;
    });
  }
}
