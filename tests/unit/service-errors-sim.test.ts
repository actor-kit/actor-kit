/**
 * Typed service errors through the step core, the journal and simulate() (ADR-016 §2): onError gets the
 * parsed error as it is, the journal stores it, replay delivers the same value, and simulate().reject takes
 * typed errors (parsed against the service's `errors`; strings and Error-likes are Defects).
 */

import { schema, uint32, view } from "@actor-kit/core";
import { replayJournal, simulate } from "@actor-kit/test";
import {
  applyJournalEvent,
  createLiveFacts,
  defineActor,
  liveStepFacts,
  message,
  step,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type PayState = { errors: unknown[] };

const Errors = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("CardDeclined"), reason: z.string() }),
  z.object({ _tag: z.literal("RateLimited"), retryAfterMs: z.number() }),
]);

const Checkout = defineActor("checkout", {
  input: z.object({}),
  init: (): PayState => ({ errors: [] }),
  roles: { any: () => true },
  services: {
    charge: {
      errors: Errors,
      fn: async () => "receipt",
      onError: (s: PayState, error: unknown) => ({ errors: [...s.errors, error] }),
    },
    plain: {
      fn: async () => null,
      onError: (s: PayState, error: unknown) => ({ errors: [...s.errors, error] }),
    },
  },
  messages: {
    PAY: message(z.object({ service: z.enum(["charge", "plain"]) }), (s: PayState, { service }, ctx) => {
      ctx.execute(service, { cents: 5 });
      return s;
    }),
  },
  views: { any: view.shared(schema({ n: uint32 }), (s: PayState) => ({ n: s.errors.length })) },
});

async function paying(service: "charge" | "plain") {
  const sim = simulate();
  const actor = await sim.spawn(Checkout, "room-1", {});
  actor.send("u", { type: "PAY", service });
  return { sim, actor };
}

describe("the step core passes a typed error through", () => {
  const def = { services: { charge: { onError: (s: PayState, e: unknown) => ({ errors: [...s.errors, e] }) } } };

  it("onError gets the error object as it is, and the journal stores it", () => {
    const error = { _tag: "CardDeclined", reason: "stolen" };
    const facts = liveStepFacts(createLiveFacts(), () => []);
    const cause = { type: "service.onError" as const, service: "charge", input: 1, error, effectId: "2:0" };
    const result = step(def, { errors: [] }, cause, facts, {});
    expect(result.state).toEqual({ errors: [error] });
    expect(result.event.payload).toEqual({ input: 1, error, effectId: "2:0" });
  });

  it("replay delivers the same typed value, every field kept", async () => {
    const error = { _tag: "RateLimited", retryAfterMs: 250 };
    const event = {
      seq: 3,
      causeType: "service.onError" as const,
      name: "charge",
      payload: { input: 1, error, effectId: "2:0" },
      caller: null,
      callerType: null,
      role: null,
      facts: {},
      codeVersion: 1,
      stateChecksum: "",
      createdAt: 0,
    };
    expect(await applyJournalEvent(def, { errors: [] }, event)).toEqual({ errors: [error] });
  });
});

describe("simulate().reject with typed errors", () => {
  it("a declared error is parsed against the service's errors and given to onError", async () => {
    const { sim, actor } = await paying("charge");
    sim.reject("2:0", { _tag: "CardDeclined", reason: "stolen" });
    expect(actor.state.errors).toEqual([{ _tag: "CardDeclined", reason: "stolen" }]);
    await replayJournal(Checkout, actor.journal);
  });

  it("the built-ins are accepted for any service", async () => {
    const timeout = await paying("plain");
    timeout.sim.reject("2:0", { _tag: "Timeout", ms: 30_000 });
    expect(timeout.actor.state.errors).toEqual([{ _tag: "Timeout", ms: 30_000 }]);
    const defect = await paying("charge");
    defect.sim.reject("2:0", { _tag: "Defect", message: "boom" });
    expect(defect.actor.state.errors).toEqual([{ _tag: "Defect", message: "boom" }]);
  });

  it("a string or an Error-like object is a Defect", async () => {
    const s = await paying("plain");
    s.sim.reject("2:0", "card reader offline");
    expect(s.actor.state.errors).toEqual([{ _tag: "Defect", message: "card reader offline" }]);
    const e = await paying("plain");
    e.sim.reject("2:0", new Error("disk full"));
    expect(e.actor.state.errors).toEqual([{ _tag: "Defect", message: "disk full" }]);
  });

  it("refuses a rejection that does not parse, and leaves the effect pending", async () => {
    const { sim, actor } = await paying("charge");
    expect(() => sim.reject("2:0", { _tag: "CardDeclined", reason: 7 })).toThrow(
      `simulate: "CardDeclined" does not match service "charge"'s errors`,
    );
    expect(() => sim.reject("2:0", { _tag: "Stolen" })).toThrow(`"Stolen" does not match`);
    expect(() => sim.reject("2:0", { _tag: "Timeout" })).toThrow("simulate: invalid Timeout error");
    expect(() => sim.reject("2:0", { _tag: "Defect", message: 5 })).toThrow("simulate: invalid Defect error");
    expect(sim.pendingEffects().map((p) => p.effectId)).toEqual(["2:0"]);
    expect(actor.state.errors).toEqual([]);
  });

  it("a rejection that does not match the service's errors is an invalid_rejection error", async () => {
    const { sim } = await paying("charge");
    expect(() => sim.reject("2:0", { _tag: "CardDeclined", reason: 7 })).toThrow(
      expect.objectContaining({ code: "invalid_rejection" }),
    );
  });

  it("refuses a declared tag for a service that declares no errors", async () => {
    const { sim } = await paying("plain");
    expect(() => sim.reject("2:0", { _tag: "CardDeclined", reason: "x" })).toThrow(
      'simulate: service "plain" declares no errors to reject with "CardDeclined"',
    );
  });

  it("an errors schema that parses to an untagged value gives a Defect", async () => {
    const Odd = defineActor("odd", {
      input: z.object({}),
      init: (): PayState => ({ errors: [] }),
      roles: { any: () => true },
      services: {
        s: {
          errors: { safeParse: () => ({ success: true as const, data: 5 }) },
          fn: async () => null,
          onError: (st: PayState, error: unknown) => ({ errors: [...st.errors, error] }),
        },
      },
      messages: {
        GO: message(z.object({}), (st: PayState, _p, ctx) => {
          ctx.execute("s", {});
          return st;
        }),
      },
      views: { any: view.shared(schema({ n: uint32 }), (st: PayState) => ({ n: st.errors.length })) },
    });
    const sim = simulate();
    const actor = await sim.spawn(Odd, "o", {});
    actor.send("u", { type: "GO" });
    sim.reject("2:0", { _tag: "X" });
    expect(actor.state.errors).toEqual([{ _tag: "Defect", message: '"X" parsed to an untagged value' }]);
  });
});

describe("simulate().reject for a service the actor does not declare", () => {
  it("a string is still a Defect, with or without a services block", async () => {
    for (const services of [{}, undefined]) {
      const Ghost = defineActor("ghost", {
        input: z.object({}),
        init: (): PayState => ({ errors: [] }),
        roles: { any: () => true },
        ...(services === undefined ? {} : { services }),
        messages: {
          GO: message(z.object({}), (st: PayState, _p, ctx) => {
            ctx.execute("missing", {});
            return st;
          }),
        },
        views: { any: view.shared(schema({ n: uint32 }), (st: PayState) => ({ n: st.errors.length })) },
      });
      const sim = simulate();
      const actor = await sim.spawn(Ghost, "g", {});
      actor.send("u", { type: "GO" });
      sim.reject("2:0", "nobody home");
      expect(sim.pendingEffects()).toEqual([]);
      expect(actor.state.errors).toEqual([]);
    }
  });
});
