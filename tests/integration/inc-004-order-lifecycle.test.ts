/**
 * INC-004 Stage 1 — Order Lifecycle Regression Suite
 *
 * This suite is the CONTRACT LOCK for INC-004 remediation. It has two parts:
 *
 *   1. Harness tests (7): prove the deterministic chaos harness itself is
 *      correct. These pass at Stage 1 and must keep passing forever.
 *
 *   2. Contract-lock tests (4): assert the presence of the modules and
 *      exports each later stage MUST introduce. They are intentionally red
 *      at Stage 1 and flip green one-by-one as Stages 2–5/6 land:
 *         - Stage 2: schema (order_intents / IntentStatus / helpers)
 *         - Stage 3: ClobAdapter
 *         - Stage 4: INC_004_INTENT_FIRST feature flag + adapter wiring
 *         - Stage 5/6: Reconciler recovery + UNIQUE constraints
 *
 * Design rules:
 *   - No production modules are imported at file scope. Contract-lock
 *     tests use dynamic import() inside the test body so a missing module
 *     produces a controlled failure, not a suite-load crash.
 *   - Zero real time, zero real randomness — only ChaosClock + injected
 *     PRNGs from the harness.
 */

import { describe, it, expect } from "vitest";
import {
  ChaosClock,
  FakeClob,
  makeCoidFactory,
  mulberry32,
  type ClobOutcome,
} from "../helpers/inc-004-chaos-harness";

// ---------------------------------------------------------------------------
// Part 1 — Harness self-tests. These lock the harness contract.
// ---------------------------------------------------------------------------
describe("INC-004 Stage 1 — Chaos harness", () => {
  it("ChaosClock advances virtual time and fires timeouts in order", () => {
    const clock = new ChaosClock();
    const events: string[] = [];
    clock.setTimeout(() => events.push("b@20"), 20);
    clock.setTimeout(() => events.push("a@10"), 10);
    clock.setTimeout(() => events.push("c@30"), 30);

    clock.advance(15);
    expect(events).toEqual(["a@10"]);
    expect(clock.now()).toBe(15);

    clock.advance(20);
    expect(events).toEqual(["a@10", "b@20", "c@30"]);
    expect(clock.now()).toBe(35);
  });

  it("ChaosClock.sleep resolves only when time advances past the deadline", async () => {
    const clock = new ChaosClock();
    let resolved = false;
    const p = clock.sleep(50).then(() => {
      resolved = true;
    });

    clock.advance(49);
    await Promise.resolve();
    expect(resolved).toBe(false);

    clock.advance(1);
    await p;
    expect(resolved).toBe(true);
  });

  it("mulberry32 is deterministic for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("FakeClob returns scripted ACK and records deterministic exchange ids", async () => {
    const clock = new ChaosClock();
    const clob = new FakeClob({ clock });
    const coid = makeCoidFactory();
    clob.scriptNext({ latencyMs: 5, outcome: { kind: "ACK", exchangeOrderId: "" } });

    const req = { clientOrderId: coid(), marketId: "m1", side: "BUY" as const, price: 0.5, size: 10 };
    const p = clob.submit(req);
    clock.advance(5);
    const outcome = (await p) as Extract<ClobOutcome, { kind: "ACK" }>;

    expect(outcome.kind).toBe("ACK");
    expect(outcome.exchangeOrderId).toBe("exch_1");
    expect(clob.getAcceptedByCoid(req.clientOrderId)).toEqual(["exch_1"]);
  });

  it("FakeClob rejects with a REJECTED terminal error", async () => {
    const clock = new ChaosClock();
    const clob = new FakeClob({ clock });
    clob.scriptNext({ latencyMs: 3, outcome: { kind: "REJECTED", reason: "MIN_SIZE" } });

    const p = clob.submit({ clientOrderId: "c1", marketId: "m1", side: "BUY", price: 0.4, size: 1 });
    clock.advance(3);
    const outcome = await p;
    expect(outcome.kind).toBe("REJECTED");
  });

  it("FakeClob models LOST_ACK: exchange accepts, client sees error", async () => {
    const clock = new ChaosClock();
    const clob = new FakeClob({ clock });
    clob.scriptNext({ latencyMs: 10, outcome: { kind: "LOST_ACK", exchangeOrderId: "" } });

    const req = { clientOrderId: "c-lost", marketId: "m1", side: "BUY" as const, price: 0.5, size: 5 };
    const p = clob.submit(req);
    clock.advance(10);
    await expect(p).rejects.toThrow(/LOST_ACK/);

    // Exchange still has the order — this is the exact recovery scenario Stage 5 must handle.
    expect(clob.getAcceptedByCoid("c-lost").length).toBe(1);
  });

  it("FakeClob models TIMEOUT and NETWORK_ERROR as rejected promises", async () => {
    const clock = new ChaosClock();
    const clob = new FakeClob({ clock });
    clob.scriptMany([
      { latencyMs: 4, outcome: { kind: "TIMEOUT" } },
      { latencyMs: 4, outcome: { kind: "NETWORK_ERROR", reason: "ECONNRESET" } },
    ]);

    const p1 = clob.submit({ clientOrderId: "c-to", marketId: "m", side: "BUY", price: 0.5, size: 1 });
    const p2 = clob.submit({ clientOrderId: "c-ne", marketId: "m", side: "BUY", price: 0.5, size: 1 });
    clock.advance(4);
    await expect(p1).rejects.toThrow(/TIMEOUT/);
    await expect(p2).rejects.toThrow(/NETWORK_ERROR/);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — Contract-lock tests. RED at Stage 1 by design.
// ---------------------------------------------------------------------------
describe("INC-004 Contract lock — later stages", () => {
  it("Stage 2: schema exports order_intents / IntentStatus / lifecycle helpers", async () => {
    const mod: any = await import("../../lib/v2/engine/db");
    expect(mod.IntentStatus, "IntentStatus enum must exist").toBeDefined();
    for (const fn of [
      "createPendingIntent",
      "markIntentSubmitted",
      "markIntentResting",
      "markIntentAmbiguous",
      "markIntentFailed",
      "quarantineExchangeOrder",
    ]) {
      expect(typeof mod[fn], `db.${fn} must be a function`).toBe("function");
    }
  });

  it("Stage 3: ClobAdapter module exists with the required public API", async () => {
    const mod: any = await import("../../lib/v2/engine/execution/clob-adapter");
    expect(typeof mod.ClobAdapter, "ClobAdapter class must exist").toBe("function");
    expect(mod.SubmissionStatus, "SubmissionStatus enum must exist").toBeDefined();
  });

  it("Stage 4: INC_004_INTENT_FIRST feature flag is defined and defaults OFF", async () => {
    const cfg: any = await import("../../lib/v2/engine/config");
    // We accept either a named flag export or a flag object.
    const flag =
      cfg.INC_004_INTENT_FIRST ??
      cfg.featureFlags?.INC_004_INTENT_FIRST ??
      cfg.FLAGS?.INC_004_INTENT_FIRST;
    expect(flag, "INC_004_INTENT_FIRST flag must be defined in config").toBeDefined();
    expect(flag, "INC_004_INTENT_FIRST must default to false").toBe(false);
  });

  it("Stage 5/6: Reconciler recovery + UNIQUE constraints landed", async () => {
    const recon: any = await import("../../lib/v2/engine/reconciler");
    // Stage 5 introduces an ambiguous-intent recovery entry point.
    expect(
      typeof recon.recoverAmbiguousIntents,
      "reconciler.recoverAmbiguousIntents must exist",
    ).toBe("function");
    // Stage 6 introduces UNIQUE constraints; we assert a hasIntentUniqueConstraints() probe on db.
    const db: any = await import("../../lib/v2/engine/db");
    expect(
      typeof db.hasIntentUniqueConstraints,
      "db.hasIntentUniqueConstraints probe must exist",
    ).toBe("function");
  });
});
