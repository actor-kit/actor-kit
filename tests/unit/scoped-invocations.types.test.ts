/**
 * ADR-019 B, types: `ctx.execute(service, input, { scope: "state" })`, `onStale` typed by the service's
 * `result`, and service callbacks of a kit with states that see the active path and may `goto` (checked
 * paths and inputs). Checked by `pnpm typecheck:types`; each @ts-expect-error must be an error.
 */
import { setup } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { ScopedCalls } from "../integration/src/scoped-calls";

type S = { n: number };

describe("scoped execute", () => {
  it("takes scope: state and returns the effect id", () => {
    const kit = setup({ states: { a: {} } });
    kit.in("a").message(z.object({}), (s: S, _p, ctx) => {
      const id = ctx.execute("svc", {}, { scope: "state" });
      expectTypeOf(id).toEqualTypeOf<string>();
      // @ts-expect-error the only scope is "state"
      ctx.execute("svc", {}, { scope: "actor" });
      return s;
    });
    expect(ScopedCalls.name).toBe("scoped-calls");
  });
});

describe("service callbacks", () => {
  const kit = setup({
    states: { idle: {}, ready: { local: z.object({ a: z.string() }), input: z.object({ a: z.string() }) } },
  });

  it("onStale gets the parsed result; callbacks of a kit with states may goto", () => {
    const lookup = kit.service({
      result: z.object({ a: z.string() }),
      fn: async () => ({ a: "x" }),
      onDone: (s: S, result, _input, ctx) => {
        expectTypeOf(ctx.phase).toEqualTypeOf<readonly ["idle"] | readonly ["ready"]>();
        // @ts-expect-error ready needs its input
        ctx.goto("ready", s);
        // @ts-expect-error not a declared state
        ctx.goto("nope", s);
        return ctx.goto("ready", s, { a: result.a });
      },
      onStale: (s: S, result, _input, ctx) => {
        expectTypeOf(result).toEqualTypeOf<{ a: string }>();
        expectTypeOf(ctx.effectId).toEqualTypeOf<string>();
        return ctx.stay(s);
      },
    });
    expect(lookup.fn).toBeDefined();
  });

  it("callbacks of a kit without states return the state and have no goto", () => {
    const flat = setup({});
    const svc = flat.service({
      fn: async () => 1,
      onDone: (s: S, _r, _i, ctx) => {
        // @ts-expect-error no states: no goto
        void ctx.goto;
        return s;
      },
      onStale: (s: S) => s,
    });
    expect(svc.fn).toBeDefined();
  });
});
