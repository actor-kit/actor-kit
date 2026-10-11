/**
 * ADR-018 G: service calls with handles, result schemas and delivery modes.
 * - ctx.execute() returns the effect id; ctx.cancel(effectId) cancels the call.
 * - onDone/onError get ctx.effectId.
 * - `result: schema` parses fn's return (only the parsed value is journaled and passed on); results over
 *   the size limit fail with a clear Defect.
 * - `delivery: "at-least-once" | "at-most-once"`; an interrupted at-most-once try becomes an
 *   OutcomeUnknown dead letter, an interrupted at-least-once try counts as an Evicted attempt.
 * - effect.record(name, value) attaches audit facts; one structured log line per attempt.
 */
import { ActorKitError } from "@actor-kit/core";
import { replayJournal, simulate, testActor } from "@actor-kit/test";
import {
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_RETRY_POLICY,
  describeServiceError,
  effectInfo,
  isBuiltInError,
  parsedOutcome,
  parseServiceResult,
  resolveServiceOptions,
  serviceAttemptEvent,
  settleInterrupted,
  setup,
  step,
  timeoutError,
} from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

type S = { calls: string[]; log: string[] };
const kit = setup({});

const Shop = kit.actor("shop", {
  input: z.object({}),
  init: (): S => ({ calls: [], log: [] }),
  roles: { any: () => true },
  messages: {
    BUY: kit.message(z.object({ cents: z.number() }), (s: S, { cents }, ctx) => {
      const id = ctx.execute("charge", { cents });
      expectTypeOf(id).toEqualTypeOf<string>();
      return { ...s, calls: [...s.calls, id] };
    }),
    CANCEL: kit.message(z.object({}), (s: S, _p, ctx) => {
      const last = s.calls.at(-1);
      if (last !== undefined) ctx.cancel(last);
      return s;
    }),
  },
  services: {
    charge: kit.service({
      result: z.object({ receipt: z.string() }),
      fn: async () => ({ receipt: "r-1" }),
      onDone: (s: S, result, _input, ctx) => {
        expectTypeOf(result).toEqualTypeOf<{ receipt: string }>();
        return { ...s, log: [...s.log, `done ${ctx.effectId} ${result.receipt}`] };
      },
      onError: (s: S, error, _input, ctx) => ({ ...s, log: [...s.log, `error ${ctx.effectId} ${error._tag}`] }),
    }),
  },
  views: {},
});

describe("ctx.execute returns the effect id", () => {
  it("in simulate, it is the pending effect's id; onDone sees it as ctx.effectId", async () => {
    const sim = simulate({ contracts: [Shop] });
    const shop = await sim.spawn(Shop, "s", {});
    shop.send("u", { type: "BUY", cents: 5 });
    const [pending] = sim.pendingEffects();
    expect(shop.state.calls).toEqual([pending?.effectId]);
    expect(pending?.effectId).toBe("2:0");
    sim.resolve("2:0", { receipt: "r-9", extra: "dropped" });
    expect(shop.state.log).toEqual(["done 2:0 r-9"]);
    await replayJournal(Shop, shop.journal);
  });

  it("onError gets ctx.effectId too", async () => {
    const sim = simulate({ contracts: [Shop] });
    const shop = await sim.spawn(Shop, "s", {});
    shop.send("u", { type: "BUY", cents: 5 });
    sim.reject("2:0", "boom");
    expect(shop.state.log).toEqual(["error 2:0 Defect"]);
  });

  it("in testActor, ids number the transition's effects from 0:0", async () => {
    const result = await testActor(Shop).send({ calls: [], log: [] }, "u", { type: "BUY", cents: 1 });
    expect(result.state.calls).toEqual(["0:0"]);
  });

  it("in the step core, the transition's seq comes from the facts", () => {
    const def = {
      messages: {
        r: {
          M: {
            handler: (_s: unknown, _p: unknown, ctx: { execute(n: string, i: unknown): string }) => ctx.execute("x", 1),
          },
        },
      },
    };
    const facts = {
      ctx: { now: () => 0, id: () => "", random: () => 0 },
      unlinkTargets: () => [],
      recorded: () => ({}),
      seq: 7,
    };
    const cause = { type: "message", name: "M", payload: {}, caller: "u", callerType: "user", role: "r" } as const;
    expect(step(def, {}, cause, facts, {}).state).toBe("7:0");
  });
});

describe("ctx.cancel(effectId)", () => {
  it("cancels a pending call: it leaves pendingEffects and its result can no longer be delivered", async () => {
    const sim = simulate({ contracts: [Shop] });
    const shop = await sim.spawn(Shop, "s", {});
    shop.send("u", { type: "BUY", cents: 5 });
    shop.send("u", { type: "CANCEL" });
    expect(sim.pendingEffects()).toEqual([]);
    let thrown: unknown;
    try {
      sim.resolve("2:0", { receipt: "late" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof ActorKitError && thrown.code).toBe("unknown_effect");
    expect(shop.state.log).toEqual([]);
    await replayJournal(Shop, shop.journal);
  });

  it("testActor records the cancel", async () => {
    const result = await testActor(Shop).send({ calls: ["4:0"], log: [] }, "u", { type: "CANCEL" });
    expect(result.cancels).toEqual(["4:0"]);
  });
});

describe("result schemas", () => {
  const charge = { result: z.object({ receipt: z.string() }) };

  it("parse the result: only the parsed value is kept", () => {
    expect(parseServiceResult("charge", charge, { receipt: "r", extra: 1 })).toEqual({
      ok: true,
      value: { receipt: "r" },
    });
  });

  it("a result that does not parse is a Defect naming the service and the issue", () => {
    const outcome = parseServiceResult("charge", charge, { receipt: 5 });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error._tag).toBe("Defect");
    expect(!outcome.ok && outcome.error.message).toMatch(
      /^Service "charge" returned a result that does not match its result schema \(receipt: .*\)\. Return a value that parses with result\.$/,
    );
  });

  it("a result over the size limit is a Defect saying the size and the limit", () => {
    const outcome = parseServiceResult("big", { maxResultBytes: 10 }, { text: "x".repeat(20) });
    expect(!outcome.ok && outcome.error.message).toBe(
      'Service "big" returned 31 bytes of JSON, over its limit of 10. Return a reference (an id or a URL) instead, or raise maxResultBytes.',
    );
    expect(parseServiceResult("ok", {}, { text: "x" })).toEqual({ ok: true, value: { text: "x" } });
    expect(DEFAULT_MAX_RESULT_BYTES).toBe(128 * 1024);
    expect(parseServiceResult("default", {}, "x".repeat(DEFAULT_MAX_RESULT_BYTES)).ok).toBe(false);
    expect(parseServiceResult("default", {}, "x".repeat(DEFAULT_MAX_RESULT_BYTES - 2)).ok).toBe(true);
  });

  it("an undefined result is allowed (a service with nothing to return)", () => {
    expect(parseServiceResult("void", {}, undefined)).toEqual({ ok: true, value: undefined });
  });

  it("simulate parses resolved results, and refuses one that does not parse", async () => {
    const sim = simulate({ contracts: [Shop] });
    const shop = await sim.spawn(Shop, "s", {});
    shop.send("u", { type: "BUY", cents: 5 });
    let thrown: unknown;
    try {
      sim.resolve("2:0", { receipt: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof ActorKitError && thrown.code).toBe("invalid_result");
    expect(sim.pendingEffects()).toHaveLength(1);
    sim.resolve("2:0", { receipt: "ok", extra: true });
    const done = shop.journal.events.at(-1);
    expect(done?.payload).toEqual({ input: { cents: 5 }, result: { receipt: "ok" }, effectId: "2:0" });
  });
});

describe("delivery modes and options", () => {
  it("default: at-least-once with the default retry policy and 128 KiB results", () => {
    expect(resolveServiceOptions("s", {})).toMatchObject({
      delivery: "at-least-once",
      policy: DEFAULT_RETRY_POLICY,
      maxResultBytes: DEFAULT_MAX_RESULT_BYTES,
    });
  });

  it("at-most-once tries once", () => {
    expect(resolveServiceOptions("s", { delivery: "at-most-once" })).toMatchObject({
      delivery: "at-most-once",
      policy: { ...DEFAULT_RETRY_POLICY, attempts: 1 },
    });
  });

  it.each([
    [{ delivery: "at-most-once", retry: { attempts: 2 } }, /at-most-once.*cannot retry/],
    [{ delivery: "twice" }, /delivery/],
    [{ maxResultBytes: 0 }, /maxResultBytes/],
    [{ result: 5 }, /result/],
  ])("refuses an invalid option %j", (options, message) => {
    let thrown: unknown;
    try {
      resolveServiceOptions("s", options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof ActorKitError && thrown.code).toBe("invalid_service_option");
    expect(thrown instanceof Error && thrown.message).toMatch(message);
  });
});

describe("tries cut off by an eviction", () => {
  // Resolved inside each test, so a broken resolver fails the test rather than the file's collection.
  const atLeastOnce = () => resolveServiceOptions("s", {});
  const atMostOnce = () => resolveServiceOptions("s", { delivery: "at-most-once" });

  it("at-most-once: an OutcomeUnknown dead letter, never sent again, no onError", () => {
    expect(settleInterrupted({ attempts: 1 }, atMostOnce(), 1000, () => 0.5)).toEqual({
      settlement: { status: "failed" },
      lastError:
        "outcome unknown: the actor was evicted while this at-most-once call ran, so it is not sent again. Check the remote system, then redrive it if it did not happen.",
      lastErrorTag: "OutcomeUnknown",
      onError: null,
    });
  });

  it("at-least-once: counted as an Evicted attempt, retried while tries are left", () => {
    expect(settleInterrupted({ attempts: 1 }, atLeastOnce(), 1000, () => 0.5)).toEqual({
      settlement: { status: "retrying", nextAttemptAt: 2000 },
      lastError: "evicted while the try ran",
      lastErrorTag: "Evicted",
      onError: null,
    });
  });

  it("at-least-once: the last try lost to eviction fails the row and runs onError with Evicted", () => {
    expect(settleInterrupted({ attempts: 3 }, atLeastOnce(), 1000, () => 0.5)).toEqual({
      settlement: { status: "failed" },
      lastError: "evicted while the try ran",
      lastErrorTag: "Evicted",
      onError: { _tag: "Evicted" },
    });
  });
});

describe("effect.record and the attempt log line", () => {
  it("effect.record collects audit facts for the try", () => {
    const audit: Record<string, unknown> = {};
    const effect = effectInfo({
      actorType: "shop",
      actorId: "s",
      effectId: "2:0",
      attempt: 1,
      signal: new AbortController().signal,
      audit,
    });
    effect.record("gateway", "stripe");
    effect.record("chargeId", "ch_1");
    expect(audit).toEqual({ gateway: "stripe", chargeId: "ch_1" });
  });

  it("one structured line per attempt, stable fields first, no input", () => {
    expect(
      serviceAttemptEvent({
        actorType: "shop",
        actorId: "s",
        service: "charge",
        effectId: "2:0",
        attempt: 2,
        durationMs: 15,
        outcome: { ok: false, error: timeoutError(10) },
      }),
    ).toEqual({
      event: "actor_kit.service.attempt",
      actorType: "shop",
      actorId: "s",
      service: "charge",
      effectId: "2:0",
      idempotencyKey: "shop/s/2:0",
      attempt: 2,
      durationMs: 15,
      ok: false,
      errorTag: "Timeout",
    });
    expect(
      serviceAttemptEvent({
        actorType: "shop",
        actorId: "s",
        service: "charge",
        effectId: "2:0",
        attempt: 1,
        durationMs: 3,
        outcome: { ok: true, result: { secret: 1 } },
      }),
    ).toStrictEqual({
      event: "actor_kit.service.attempt",
      actorType: "shop",
      actorId: "s",
      service: "charge",
      effectId: "2:0",
      idempotencyKey: "shop/s/2:0",
      attempt: 1,
      durationMs: 3,
      ok: true,
    });
  });
});

describe("service handles: edges", () => {
  it("parsedOutcome keeps aborted and failed tries, parses a result", () => {
    const options = { result: z.object({ n: z.number() }) };
    expect(parsedOutcome("s", options, { aborted: true })).toEqual({ aborted: true });
    const failed = { ok: false, error: timeoutError(5) } as const;
    expect(parsedOutcome("s", options, failed)).toBe(failed);
    expect(parsedOutcome("s", options, { ok: true, result: { n: 1, x: 2 } })).toEqual({ ok: true, result: { n: 1 } });
    expect(parsedOutcome("s", options, { ok: true, result: { n: "1" } })).toMatchObject({
      ok: false,
      error: { _tag: "Defect" },
    });
  });

  it("result schema errors without issues use the parser's message; nested paths are dotted and joined", () => {
    const plain = { safeParse: () => ({ success: false as const, error: { message: "nope" } }) };
    expect(parseServiceResult("s", { result: plain }, 1)).toMatchObject({
      ok: false,
      error: {
        message:
          'Service "s" returned a result that does not match its result schema (nope). Return a value that parses with result.',
      },
    });
    const nested = z.object({ a: z.object({ b: z.number() }), c: z.string() });
    expect(parseServiceResult("s", { result: nested }, { a: { b: "x" }, c: 1 })).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining(
          "(a.b: Invalid input: expected number, received string; c: Invalid input: expected string, received number)",
        ),
      },
    });
  });

  it("a result that is not JSON is a Defect saying so", () => {
    expect(parseServiceResult("s", {}, { n: 1n })).toEqual({
      ok: false,
      error: {
        _tag: "Defect",
        message:
          'Service "s" returned a result that is not JSON (it holds a BigInt, a cycle or similar). Return plain JSON data.',
      },
    });
  });

  it("an undefined result is 0 bytes", () => {
    expect(parseServiceResult("s", { maxResultBytes: 1 }, undefined)).toEqual({ ok: true, value: undefined });
  });

  it("delivery, retry and result options are read", () => {
    expect(resolveServiceOptions("s", { delivery: "at-least-once" }).delivery).toBe("at-least-once");
    expect(resolveServiceOptions("s", { retry: { attempts: 5 } }).policy.attempts).toBe(5);
    const onlyDeclined = (error: { _tag: string }) => error._tag === "Declined";
    const rule = resolveServiceOptions("s", { retry: { while: onlyDeclined } }).rule;
    expect([rule({ _tag: "Declined" }), rule({ _tag: "Timeout" })]).toEqual([true, false]);
    expect(resolveServiceOptions("s", { delivery: "at-most-once", retry: { attempts: 1 } }).policy.attempts).toBe(1);
    expect(resolveServiceOptions("s", { delivery: "at-least-once", retry: { attempts: 2 } }).policy.attempts).toBe(2);
    const schema = z.number();
    expect(resolveServiceOptions("s", { result: schema }).result).toBe(schema);
  });

  it.each([
    [{ result: null }],
    [{ result: {} }],
    [{ result: { safeParse: 5 } }],
    [{ delivery: "at-most-once", retry: {} }],
  ])("refuses %j", (options) => {
    let thrown: unknown;
    try {
      resolveServiceOptions("s", options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof ActorKitError && thrown.code).toBe("invalid_service_option");
  });

  it("names a result that is not a schema", () => {
    let thrown: unknown;
    try {
      resolveServiceOptions("s", { result: 5 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error && thrown.message).toContain("expected a Zod schema");
  });

  it("Evicted is a built-in error: retried by default, described, and simulate can reject with it", async () => {
    expect(isBuiltInError({ _tag: "Evicted" })).toBe(true);
    expect(isBuiltInError({ _tag: "Other" })).toBe(false);
    expect(describeServiceError({ _tag: "Evicted" })).toBe("evicted while the try ran");
    expect(describeServiceError(timeoutError(3))).toBe("timed out after 3ms");
    const sim = simulate({ contracts: [Shop] });
    const shop = await sim.spawn(Shop, "s", {});
    shop.send("u", { type: "BUY", cents: 5 });
    sim.reject("2:0", { _tag: "Evicted" });
    expect(shop.state.log).toEqual(["error 2:0 Evicted"]);
  });

  it("the step core journals audit facts with the result, and gives ctx.effectId (empty for old entries)", () => {
    const seen: string[] = [];
    const def = {
      services: {
        pay: {
          onDone: (s: unknown, _r: unknown, _i: unknown, ctx: { effectId: string }) => {
            seen.push(ctx.effectId);
            return s;
          },
        },
      },
    };
    const facts = {
      ctx: { now: () => 0, id: () => "", random: () => 0 },
      unlinkTargets: () => [],
      recorded: () => ({}),
    };
    const withAudit = step(
      def,
      {},
      { type: "service.onDone", service: "pay", input: 1, result: 2, effectId: "3:0", audit: { a: 1 } },
      facts,
      {},
    );
    expect(withAudit.event.payload).toEqual({ input: 1, result: 2, effectId: "3:0", audit: { a: 1 } });
    const old = step(def, {}, { type: "service.onDone", service: "pay", input: 1, result: 2 }, facts, {});
    expect(old.event.payload).toStrictEqual({ input: 1, result: 2 });
    expect(seen).toEqual(["3:0", ""]);
  });

  it("simulate cancels only the cancelling actor's calls, and only cancels (not a timer key that matches)", async () => {
    const Clock = kit.actor("clock", {
      input: z.object({}),
      init: (): { ids: string[] } => ({ ids: [] }),
      roles: { any: () => true },
      messages: {
        GO: kit.message(z.object({}), (s: { ids: string[] }, _p, ctx) => {
          const id = ctx.execute("work", {});
          ctx.schedule("tick", { in: 10, key: id });
          return { ids: [...s.ids, id] };
        }),
        STOP: kit.message(z.object({ id: z.string() }), (s: { ids: string[] }, { id }, ctx) => {
          ctx.cancel(id);
          return s;
        }),
      },
      timers: { tick: kit.timer(z.undefined(), (s: { ids: string[] }) => s) },
      views: {},
    });
    const sim = simulate({ contracts: [Clock] });
    const a = await sim.spawn(Clock, "a", {});
    const b = await sim.spawn(Clock, "b", {});
    a.send("u", { type: "GO" });
    b.send("u", { type: "GO" });
    expect(sim.pendingEffects().map((p) => `${p.actor.id}:${p.effectId}`)).toEqual(["a:2:0", "b:2:0"]);
    a.send("u", { type: "STOP", id: "2:0" });
    expect(sim.pendingEffects().map((p) => `${p.actor.id}:${p.effectId}`)).toEqual(["b:2:0"]);
  });

  it("simulate: a call to a service the actor does not declare resolves as is; invalid options refuse the contract", async () => {
    const Bare = kit.actor("bare", {
      input: z.object({}),
      init: (): { got: unknown[] } => ({ got: [] }),
      roles: { any: () => true },
      messages: {
        GO: kit.message(z.object({}), (s: { got: unknown[] }, _p, ctx) => (ctx.execute("x", {}) === "" ? s : s)),
      },
      views: {},
    });
    const sim = simulate({ contracts: [Bare] });
    const bare = await sim.spawn(Bare, "b", {});
    bare.send("u", { type: "GO" });
    sim.resolve("2:0", { anything: true });
    expect(sim.pendingEffects()).toEqual([]);
    const Bad = kit.actor("bad", {
      input: z.object({}),
      init: () => ({}),
      roles: { any: () => true },
      services: { s: { delivery: "at-most-once", retry: { attempts: 2 }, fn: async () => 1 } },
      views: {},
    });
    let thrown: unknown;
    try {
      await simulate({ contracts: [Bad] }).spawn(Bad, "x", {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof ActorKitError && thrown.code).toBe("invalid_service_option");
  });

  it("simulate's invalid_result names the service", async () => {
    const sim = simulate({ contracts: [Shop] });
    const shop = await sim.spawn(Shop, "s", {});
    shop.send("u", { type: "BUY", cents: 5 });
    let thrown: unknown;
    try {
      sim.resolve("2:0", { receipt: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error && thrown.message).toMatch(
      /^simulate: Service "charge" returned a result that does not match/,
    );
  });
});
