import { timer } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

type State = { phase: string; round: number };

describe("timer() helper", () => {
  it("pairs a payload schema with a handler", () => {
    const schema = z.object({ round: z.number() });
    const handler = (s: State, { round }: { round: number }) => (s.round === round ? { ...s, phase: "reveal" } : s);
    const def = timer(schema, handler);
    expect(def.schema).toBe(schema);
    expect(def.handler).toBe(handler);
  });

  it("types the payload from the schema and gives the handler the timer context", () => {
    timer(z.object({ round: z.number() }), (s: State, payload, ctx) => {
      expectTypeOf(payload).toEqualTypeOf<{ round: number }>();
      expectTypeOf(ctx.lateBy).toEqualTypeOf<number>();
      expectTypeOf(ctx.key).toEqualTypeOf<string>();
      expectTypeOf(ctx.schedule).toBeFunction();
      return s;
    });
  });
});
