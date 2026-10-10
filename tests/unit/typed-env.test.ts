/**
 * Typed env (ADR-016 §4): binding helpers check a binding's runtime shape; the env is parsed against the
 * actor's `env` schema (refused with every bad binding named); testActor and simulate take fakes parsed the
 * same way, and handlers, services and onDone/onError see the parsed env.
 */

import { schema, uint32, view } from "@actor-kit/core";
import { simulate, testActor } from "@actor-kit/test";
import {
  d1,
  defineActor,
  durableObject,
  envErrorMessage,
  envInvalidEvent,
  kv,
  message,
  parseActorEnv,
  queue,
  r2,
  service,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const fn = () => undefined;
const withMethods = (...names: string[]) => Object.fromEntries(names.map((name) => [name, fn]));

describe("binding helpers", () => {
  it.each([
    ["service", service(), withMethods("fetch"), "a service"],
    ["durableObject", durableObject(), withMethods("idFromName", "get"), "a Durable Object namespace"],
    ["queue", queue(), withMethods("send", "sendBatch"), "a Queue"],
    ["kv", kv(), withMethods("get", "put", "delete", "list"), "a KV namespace"],
    ["r2", r2(), withMethods("get", "put", "head", "delete", "list"), "an R2 bucket"],
    ["d1", d1(), withMethods("prepare", "batch", "exec"), "a D1 database"],
  ] as const)(
    "%s() passes a binding with its methods through, and refuses anything else",
    (_name, helper, good, kind) => {
      expect(helper.parse(good)).toBe(good);
      const methods = Object.keys(good);
      for (const missing of methods) {
        const partial = { ...good, [missing]: "not a function" };
        expect(helper.safeParse(partial).success).toBe(false);
      }
      const refused = helper.safeParse(undefined);
      expect(refused.success).toBe(false);
      expect(refused.error?.issues[0]?.message).toBe(`expected ${kind} binding`);
      expect(helper.safeParse("string").success).toBe(false);
      expect(helper.safeParse(null).success).toBe(false);
    },
  );
});

const Env = z.object({ PAYMENTS: service(), CACHE: kv(), STRIPE_KEY: z.string().min(1) });

describe("parseActorEnv", () => {
  it("passes the env through without a schema", () => {
    const env = { ANYTHING: 1 };
    expect(parseActorEnv(undefined, env)).toEqual({ ok: true, env });
  });

  it("returns the parsed env: declared bindings only", () => {
    const payments = withMethods("fetch");
    const cache = withMethods("get", "put", "delete", "list");
    expect(parseActorEnv(Env, { PAYMENTS: payments, CACHE: cache, STRIPE_KEY: "pk", EXTRA: 1 })).toEqual({
      ok: true,
      env: { PAYMENTS: payments, CACHE: cache, STRIPE_KEY: "pk" },
    });
  });

  it("names every missing or wrong binding", () => {
    const parsed = parseActorEnv(Env, { CACHE: {}, STRIPE_KEY: "" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((issue) => issue.binding)).toEqual(["PAYMENTS", "CACHE", "STRIPE_KEY"]);
    expect(parsed.issues[0]?.message).toBe("expected a service binding");
  });

  it("an env that is not an object is one issue for the whole env", () => {
    const parsed = parseActorEnv(Env, undefined);
    expect(parsed).toEqual({ ok: false, issues: [{ binding: "(env)", message: expect.any(String) }] });
  });
});

describe("the refusal", () => {
  const issues = [
    { binding: "PAYMENTS", message: "expected a service binding" },
    { binding: "STRIPE_KEY", message: "Too small" },
  ];

  it("the 500's text names the actor and each binding", () => {
    expect(envErrorMessage("checkout", issues)).toBe(
      'Actor "checkout" cannot run: its env does not match its schema.\n- PAYMENTS: expected a service binding\n- STRIPE_KEY: Too small',
    );
  });

  it("the one structured log line carries the binding names and reasons, never values", () => {
    expect(envInvalidEvent("checkout", issues)).toEqual({
      event: "actor_kit.env.invalid",
      actorType: "checkout",
      bindings: ["PAYMENTS", "STRIPE_KEY"],
      issues,
    });
  });
});

type S = { seen: string[] };

const Checkout = defineActor("checkout", {
  input: z.object({}),
  init: (): S => ({ seen: [] }),
  env: z.object({ STRIPE_KEY: z.string().min(1), PAYMENTS: service() }),
  roles: { any: () => true },
  services: {
    charge: {
      fn: async () => null,
      onDone: (s: S, _r: unknown, _i: unknown, ctx: { env: { STRIPE_KEY: string } }) => ({
        seen: [...s.seen, `done:${ctx.env.STRIPE_KEY}`],
      }),
      onError: (s: S, _e: unknown, _i: unknown, ctx: { env: { STRIPE_KEY: string } }) => ({
        seen: [...s.seen, `error:${ctx.env.STRIPE_KEY}`],
      }),
    },
  },
  messages: {
    PAY: message(
      z.object({}),
      (s: S, _p, ctx: { env: { STRIPE_KEY: string }; execute(n: string, i: unknown): void }) => {
        ctx.execute("charge", {});
        return { seen: [...s.seen, `pay:${ctx.env.STRIPE_KEY}`] };
      },
    ),
  },
  views: { any: view.shared(schema({ n: uint32 }), (s: S) => ({ n: s.seen.length })) },
});

const fakes = { STRIPE_KEY: "pk_test", PAYMENTS: withMethods("fetch"), UNDECLARED: "dropped" };

describe("testActor(contract, { env })", () => {
  it("handlers see the parsed fakes", async () => {
    const t = testActor(Checkout, { env: fakes });
    const { state } = await t.send(t.init({}), "u", { type: "PAY" });
    expect(state.seen).toEqual(["pay:pk_test"]);
  });

  it("fakes that don't match the schema are refused, naming each binding", () => {
    expect(() => testActor(Checkout, { env: { STRIPE_KEY: "" } })).toThrow(
      'testActor: Actor "checkout" cannot run: its env does not match its schema.\n- STRIPE_KEY:',
    );
    expect(() => testActor(Checkout)).toThrow("- (env):");
  });
});

describe("simulate({ env: { contract: fakes } })", () => {
  it("handlers, onDone and onError see the contract's parsed fakes", async () => {
    const sim = simulate({ env: { checkout: fakes } });
    const actor = await sim.spawn(Checkout, "c1", {});
    actor.send("u", { type: "PAY" });
    sim.resolve("2:0", null);
    actor.send("u", { type: "PAY" });
    sim.reject("4:0", "down");
    expect(actor.state.seen).toEqual(["pay:pk_test", "done:pk_test", "pay:pk_test", "error:pk_test"]);
  });

  it("fakes that don't match are refused when the actor is spawned", async () => {
    const sim = simulate({ env: { checkout: { STRIPE_KEY: "pk" } } });
    await expect(sim.spawn(Checkout, "c1", {})).rejects.toThrow('simulate: Actor "checkout" cannot run');
    const missing = simulate({ env: "not keyed by contract" });
    await expect(missing.spawn(Checkout, "c1", {})).rejects.toThrow("- (env):");
  });
});
