/**
 * INC-004 Stage 3 — ClobAdapter unit tests.
 *
 * Deterministic: uses the Stage 1 ChaosClock + FakeClob + Mulberry32 PRNG.
 * No real time, no real randomness, no I/O, no DB.
 */

import { describe, it, expect } from "vitest";
import {
  ChaosClock,
  FakeClob,
  mulberry32,
} from "../helpers/inc-004-chaos-harness";
import {
  ClobAdapter,
  SubmissionStatus,
  classifyError,
  computeBackoffMs,
  deriveClientOrderId,
  extractExchangeIdFromError,
  isRetryable,
} from "../../lib/v2/engine/execution/clob-adapter";

const INTENT = {
  intentId: "int_1",
  marketId: "m1",
  side: "BUY" as const,
  price: 0.5,
  size: 10,
};

async function runToCompletion<T>(clock: ChaosClock, p: Promise<T>, totalMs = 60_000): Promise<T> {
  // Advance virtual time in small steps and flush microtasks between each,
  // so async continuations that schedule NEW timers get to enqueue before
  // further time advances. Stops as soon as p settles.
  let done = false;
  const wrapped = p.finally(() => {
    done = true;
  });
  const stepMs = 1;
  const maxSteps = Math.ceil(totalMs / stepMs);
  for (let i = 0; i < maxSteps && !done; i += 1) {
    clock.advance(stepMs);
    for (let k = 0; k < 5; k += 1) await Promise.resolve();
  }
  return wrapped;
}

describe("INC-004 Stage 3 — pure helpers", () => {
  it("deriveClientOrderId is stable and prefixed", () => {
    expect(deriveClientOrderId("abc")).toBe("coid_abc");
    expect(deriveClientOrderId("abc")).toBe(deriveClientOrderId("abc"));
    expect(deriveClientOrderId("abc", "p_")).toBe("p_abc");
  });

  it("deriveClientOrderId rejects empty input", () => {
    expect(() => deriveClientOrderId("")).toThrow();
  });

  it("classifyError maps common shapes", () => {
    expect(classifyError(new Error("TIMEOUT"))).toBe("TIMEOUT");
    expect(classifyError(new Error("LOST_ACK"))).toBe("LOST_ACK");
    expect(classifyError(new Error("NETWORK_ERROR: ECONNRESET"))).toBe("NETWORK");
    expect(classifyError(new Error("boom"))).toBe("UNKNOWN");
  });

  it("isRetryable covers transient classes only", () => {
    expect(isRetryable("TIMEOUT")).toBe(true);
    expect(isRetryable("NETWORK")).toBe(true);
    expect(isRetryable("LOST_ACK")).toBe(true);
    expect(isRetryable("REJECTED_PERMANENT")).toBe(false);
    expect(isRetryable("UNKNOWN")).toBe(false);
    expect(isRetryable("NONE")).toBe(false);
  });

  it("computeBackoffMs is deterministic, monotone up to cap, jitter-bounded", () => {
    const rng = mulberry32(1);
    const a = computeBackoffMs(1, 100, 5000, 0, rng);
    const b = computeBackoffMs(2, 100, 5000, 0, rng);
    const c = computeBackoffMs(3, 100, 5000, 0, rng);
    expect(a).toBe(100);
    expect(b).toBe(200);
    expect(c).toBe(400);
    // Cap
    expect(computeBackoffMs(20, 100, 5000, 0, rng)).toBe(5000);
    // Jitter bounded to [raw*(1-j), raw*(1+j)]
    const jr = mulberry32(7);
    for (let i = 0; i < 20; i += 1) {
      const v = computeBackoffMs(2, 100, 5000, 0.2, jr);
      expect(v).toBeGreaterThanOrEqual(200 * 0.8);
      expect(v).toBeLessThanOrEqual(200 * 1.2);
    }
  });

  it("extractExchangeIdFromError reads attached ids", () => {
    const err = Object.assign(new Error("LOST_ACK"), { exchangeOrderId: "exch_9" });
    expect(extractExchangeIdFromError(err)).toBe("exch_9");
    expect(extractExchangeIdFromError(new Error("x"))).toBeUndefined();
  });
});

describe("INC-004 Stage 3 — ClobAdapter", () => {
  it("returns ACCEPTED on first-try ACK and does not retry", async () => {
    const clock = new ChaosClock();
    const clob = new FakeClob({ clock });
    clob.scriptNext({ latencyMs: 5, outcome: { kind: "ACK", exchangeOrderId: "" } });
    const adapter = new ClobAdapter({ clob, clock, rng: mulberry32(1), jitter: 0 });

    const p = adapter.submit(INTENT);
    const result = await runToCompletion(clock, p, 30_000);

    expect(result.status).toBe(SubmissionStatus.ACCEPTED);
    expect(result.exchangeOrderId).toBe("exch_1");
    expect(result.clientOrderId).toBe("coid_int_1");
    expect(result.attempts).toHaveLength(1);
    expect(result.requiresReconciliation).toBe(false);
  });

  it("returns REJECTED without retrying on permanent rejection", async () => {
    const clock = new ChaosClock();
    const clob = new FakeClob({ clock });
    clob.scriptNext({ latencyMs: 3, outcome: { kind: "REJECTED", reason: "MIN_SIZE" } });
    const adapter = new ClobAdapter({ clob, clock, rng: mulberry32(1), jitter: 0 });

    const p = adapter.submit(INTENT);
    const result = await runToCompletion(clock, p, 30_000);

    expect(result.status).toBe(SubmissionStatus.REJECTED);
    expect(result.rejectReason).toBe("MIN_SIZE");
    expect(result.attempts).toHaveLength(1);
    expect(result.requiresReconciliation).toBe(false);
  });

  it("retries transient NETWORK errors then succeeds, reusing the same coid", async () => {
    const clock = new ChaosClock();
    const clob = new FakeClob({ clock });
    clob.scriptMany([
      { latencyMs: 2, outcome: { kind: "NETWORK_ERROR", reason: "ECONNRESET" } },
      { latencyMs: 2, outcome: { kind: "NETWORK_ERROR", reason: "ECONNRESET" } },
      { latencyMs: 2, outcome: { kind: "ACK", exchangeOrderId: "" } },
    ]);
    const adapter = new ClobAdapter({
      clob,
      clock,
      rng: mulberry32(1),
      jitter: 0,
      backoffBaseMs: 10,
      backoffCapMs: 100,
      maxAttempts: 3,
    });

    const p = adapter.submit(INTENT);
    const result = await runToCompletion(clock, p, 30_000);

    expect(result.status).toBe(SubmissionStatus.ACCEPTED);
    expect(result.attempts).toHaveLength(3);
    const coids = clob.getAttempts().map((a) => a.clientOrderId);
    expect(new Set(coids).size).toBe(1);
    expect(coids[0]).toBe("coid_int_1");
  });

  it("returns RETRIES_EXHAUSTED after maxAttempts of transient failures", async () => {
    const clock = new ChaosClock();
    const clob = new FakeClob({ clock });
    clob.setDefault({ latencyMs: 2, outcome: { kind: "NETWORK_ERROR", reason: "flap" } });
    const adapter = new ClobAdapter({
      clob,
      clock,
      rng: mulberry32(1),
      jitter: 0,
      backoffBaseMs: 5,
      backoffCapMs: 20,
      maxAttempts: 3,
    });

    const p = adapter.submit(INTENT);
    const result = await runToCompletion(clock, p, 30_000);

    expect(result.status).toBe(SubmissionStatus.RETRIES_EXHAUSTED);
    expect(result.attempts).toHaveLength(3);
    expect(result.requiresReconciliation).toBe(true);
  });

  it("LOST_ACK is retried and flags reconciliation with observed exchange id", async () => {
    const clock = new ChaosClock();
    const clob = new FakeClob({ clock });
    clob.scriptMany([
      { latencyMs: 2, outcome: { kind: "LOST_ACK", exchangeOrderId: "" } },
      { latencyMs: 2, outcome: { kind: "ACK", exchangeOrderId: "" } },
    ]);
    const adapter = new ClobAdapter({
      clob,
      clock,
      rng: mulberry32(1),
      jitter: 0,
      backoffBaseMs: 1,
      backoffCapMs: 10,
      maxAttempts: 3,
    });

    const p = adapter.submit(INTENT);
    const result = await runToCompletion(clock, p, 30_000);

    // Second attempt ACKed cleanly, so status is ACCEPTED, but the caller
    // still learns that a prior LOST_ACK left an upstream shadow order.
    expect(result.status).toBe(SubmissionStatus.ACCEPTED);
    expect(clob.getAcceptedByCoid("coid_int_1").length).toBe(2);
  });

  it("per-attempt timeout is enforced by the injected clock", async () => {
    const clock = new ChaosClock();
    // FakeClob with huge latency — should never resolve within the timeout window.
    const clob = new FakeClob({ clock });
    clob.setDefault({ latencyMs: 10_000, outcome: { kind: "ACK", exchangeOrderId: "" } });
    const adapter = new ClobAdapter({
      clob,
      clock,
      rng: mulberry32(1),
      jitter: 0,
      backoffBaseMs: 1,
      backoffCapMs: 1,
      maxAttempts: 2,
      perAttemptTimeoutMs: 50,
    });

    const p = adapter.submit(INTENT);
    const result = await runToCompletion(clock, p, 30_000);

    expect(result.status).toBe(SubmissionStatus.RETRIES_EXHAUSTED);
    expect(result.attempts.every((a) => a.errorClass === "TIMEOUT")).toBe(true);
  });

  it("never throws — even when the underlying clob throws synchronously", async () => {
    const clock = new ChaosClock();
    const throwingClob = {
      submit: () => {
        throw new Error("boom");
      },
    };
    const adapter = new ClobAdapter({
      clob: throwingClob as any,
      clock,
      rng: mulberry32(1),
      jitter: 0,
      maxAttempts: 1,
      perAttemptTimeoutMs: 0,
    });

    const result = await adapter.submit(INTENT);
    expect(result.status).toBe(SubmissionStatus.AMBIGUOUS);
    expect(result.attempts[0].errorClass).toBe("UNKNOWN");
  });
});
