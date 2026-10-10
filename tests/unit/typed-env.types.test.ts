/**
 * Types of the typed env (ADR-016 §4): with an `env` schema, a service's fn, its onDone/onError ctx and the
 * lifecycle handlers see `z.infer<typeof env>`; without one, env is `unknown`. Checked by `pnpm typecheck:types`.
 */

import { schema, uint32, view } from "@actor-kit/core";
import { defineActor, kv, service } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

interface PaymentsApi {
  fetch(request: Request): Promise<Response>;
  charge(cents: number, options: { idempotencyKey: string }): Promise<{ ok: boolean; receipt: string }>;
}

type S = { n: number };

describe("typed env", () => {
  it("fn, onDone/onError ctx and lifecycle see the parsed env", () => {
    const Checkout = defineActor("checkout", {
      input: z.object({}),
      init: (): S => ({ n: 0 }),
      env: z.object({ PAYMENTS: service<PaymentsApi>(), CACHE: kv(), STRIPE_KEY: z.string().min(1) }),
      roles: { any: () => true },
      views: { any: view.shared(schema({ n: uint32 }), (s: S) => ({ n: s.n })) },
      services: {
        charge: {
          fn: async (input: { cents: number }, env, effect) => {
            expectTypeOf(env.PAYMENTS).toEqualTypeOf<PaymentsApi>();
            expectTypeOf(env.CACHE).toEqualTypeOf<KVNamespace>();
            expectTypeOf(env.STRIPE_KEY).toEqualTypeOf<string>();
            return env.PAYMENTS.charge(input.cents, { idempotencyKey: effect.idempotencyKey });
          },
          onDone: (state, _result, _input, ctx) => {
            expectTypeOf(ctx.env.STRIPE_KEY).toEqualTypeOf<string>();
            return state;
          },
          onError: (state, _error, _input, ctx) => {
            expectTypeOf(ctx.env.PAYMENTS).toEqualTypeOf<PaymentsApi>();
            return state;
          },
        },
      },
      lifecycle: {
        connect: (state, _event, ctx) => {
          expectTypeOf(ctx.env.STRIPE_KEY).toEqualTypeOf<string>();
          return state;
        },
      },
    });
    expect(Checkout.name).toBe("checkout");
  });

  it("env is unknown without a schema", () => {
    defineActor("plain", {
      input: z.object({}),
      init: (): S => ({ n: 0 }),
      roles: { any: () => true },
      views: { any: view.shared(schema({ n: uint32 }), (s: S) => ({ n: s.n })) },
      services: {
        s: {
          fn: async (_i, env) => {
            expectTypeOf(env).toEqualTypeOf<unknown>();
            return null;
          },
        },
      },
    });
  });

  it("reading a binding the schema does not declare is a type error", () => {
    defineActor("strict", {
      input: z.object({}),
      init: (): S => ({ n: 0 }),
      env: z.object({ KEY: z.string() }),
      roles: { any: () => true },
      views: { any: view.shared(schema({ n: uint32 }), (s: S) => ({ n: s.n })) },
      services: {
        s: {
          // @ts-expect-error OTHER is not in the env schema
          fn: async (_i, env) => env.OTHER,
        },
      },
    });
  });
});
