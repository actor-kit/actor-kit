/**
 * Types of typed services (ADR-016 §2): `errors` types `onError` and `retry.while` as the declared errors
 * plus the built-ins; without `errors` they get only the built-ins. Checked by tsc (pnpm typecheck:types),
 * these tests also run (trivially) under Vitest.
 */

import { schema, uint32, view } from "@actor-kit/core";
import { type BuiltInError, defineActor, fail, type ServiceFailure } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

type S = { n: number; last: string };

const Errors = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("CardDeclined"), reason: z.string() }),
  z.object({ _tag: z.literal("RateLimited"), retryAfterMs: z.number() }),
]);
type Declared = z.infer<typeof Errors>;

describe("typed service errors", () => {
  it("onError and retry.while see the declared errors plus Timeout and Defect", () => {
    const Checkout = defineActor("checkout", {
      input: z.object({}),
      init: (): S => ({ n: 0, last: "" }),
      roles: { any: () => true },
      views: { any: view.shared(schema({ n: uint32 }), (s: S) => ({ n: s.n })) },
      services: {
        charge: {
          errors: Errors,
          fn: async (input: { cents: number }) => {
            if (input.cents > 100) throw fail({ _tag: "CardDeclined", reason: "limit" });
            return "receipt";
          },
          retry: {
            attempts: 5,
            while: (error) => {
              expectTypeOf(error).toEqualTypeOf<Declared | BuiltInError>();
              return error._tag === "RateLimited" || error._tag === "Timeout";
            },
          },
          onError: (state, error) => {
            expectTypeOf(state).toEqualTypeOf<S>();
            expectTypeOf(error).toEqualTypeOf<Declared | BuiltInError>();
            if (error._tag === "CardDeclined") return { ...state, last: error.reason };
            if (error._tag === "RateLimited") return { ...state, n: error.retryAfterMs };
            if (error._tag === "Timeout") return { ...state, n: error.ms };
            return { ...state, last: error.message };
          },
        },
        plain: {
          fn: async () => null,
          onError: (state, error) => {
            expectTypeOf(error).toEqualTypeOf<BuiltInError>();
            return state;
          },
        },
      },
    });
    expect(Checkout.name).toBe("checkout");
  });

  it("an onError that reads a field no error has is a type error", () => {
    defineActor("bad", {
      input: z.object({}),
      init: (): S => ({ n: 0, last: "" }),
      roles: { any: () => true },
      views: { any: view.shared(schema({ n: uint32 }), (s: S) => ({ n: s.n })) },
      services: {
        plain: {
          fn: async () => null,
          // @ts-expect-error a Timeout has no message: onError must narrow on _tag first
          onError: (state, error) => ({ ...state, last: error.message }),
        },
      },
    });
  });

  it("fail() keeps the literal tag", () => {
    expectTypeOf(fail({ _tag: "CardDeclined", reason: "x" })).toEqualTypeOf<
      ServiceFailure<{ readonly _tag: "CardDeclined"; readonly reason: "x" }>
    >();
    // @ts-expect-error a failure needs a _tag
    fail({ reason: "x" });
  });
});
