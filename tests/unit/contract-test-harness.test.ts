import { schema, string, uint32, view } from "@actor-kit/core";
import { testActor } from "@actor-kit/test";
import { defineActor, message } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

// --- Test fixtures ---

type CounterState = { count: number; name: string };

const CounterView = schema({ count: uint32, name: string });
const SummaryView = schema({ total: uint32 });

const Counter = defineActor("counter", {
  input: z.object({ initial: z.number() }),
  init: (input: { initial: number }): CounterState => ({ count: input.initial, name: "" }),
  roles: {
    admin: (_state: CounterState, caller: string) => caller === "admin",
    viewer: () => true,
  },
  messages: {
    INCREMENT: message(z.object({ amount: z.number() }), (state: CounterState, { amount }) => ({
      count: state.count + amount,
      name: state.name,
    })),
    RESET: message(z.object({}), (state: CounterState) => ({
      count: 0,
      name: state.name,
    })),
    RENAME: message(z.object({ newName: z.string() }), (state: CounterState, { newName }) => ({
      count: state.count,
      name: newName,
    })),
    ADMIN_ONLY: message(z.object({}), {
      guard: (_state: CounterState, _payload: unknown, ctx: { role: string }) => ctx.role === "admin",
      handler: (state: CounterState) => ({ ...state, count: 999 }),
    }),
  },
  views: {
    admin: view(CounterView, (state: CounterState) => ({
      count: state.count,
      name: state.name,
    })),
    viewer: view(SummaryView, (state: CounterState) => ({
      total: state.count,
    })),
  },
});

// --- Type inference tests ---

describe("contract-derived test harness", () => {
  it("testActor(contract) infers input type for init()", () => {
    const t = testActor(Counter);

    // init accepts typed input
    const state = t.init({ initial: 5 });
    expectTypeOf(state).toEqualTypeOf<CounterState>();
    expect(state).toEqual({ count: 5, name: "" });

    // Type-level: init requires correct input shape
    expectTypeOf(t.init).parameter(0).toEqualTypeOf<{ initial: number }>();
  });

  it("testActor(contract) infers state type from init()", () => {
    const t = testActor(Counter);
    const state = t.init({ initial: 0 });

    // State is fully typed
    expectTypeOf(state).toEqualTypeOf<{ count: number; name: string }>();
    expect(state.count).toBe(0);
    expect(state.name).toBe("");
  });

  it("testActor(contract).send() accepts typed events from flat messages", () => {
    const t = testActor(Counter);

    type SendEvent = Parameters<typeof t.send>[2];

    // Should accept valid events
    type ExpectedEvent =
      | { type: "INCREMENT"; amount: number }
      | { type: "RESET" }
      | { type: "RENAME"; newName: string }
      | { type: "ADMIN_ONLY" };

    expectTypeOf<SendEvent>().toEqualTypeOf<ExpectedEvent>();
  });

  it("testActor(contract).sendWithEffects() accepts typed events", () => {
    const t = testActor(Counter);

    type SendEvent = Parameters<typeof t.sendWithEffects>[2];

    type ExpectedEvent =
      | { type: "INCREMENT"; amount: number }
      | { type: "RESET" }
      | { type: "RENAME"; newName: string }
      | { type: "ADMIN_ONLY" };

    expectTypeOf<SendEvent>().toEqualTypeOf<ExpectedEvent>();
  });

  it("testActor(contract).view() returns typed view data", () => {
    const t = testActor(Counter);
    const state = t.init({ initial: 10 });
    const result = t.view(state, "admin");

    // data should be the union of all view types
    type ExpectedData = { count: number; name: string } | { total: number };
    expectTypeOf(result.data).toEqualTypeOf<ExpectedData>();
  });

  it("testActor(contract) runtime: init → send → view works", async () => {
    const t = testActor(Counter);
    const state = t.init({ initial: 0 });

    expect(state).toEqual({ count: 0, name: "" });

    const next = await t.send(state, "admin", { type: "INCREMENT", amount: 5 });
    expect(next).toEqual({ count: 5, name: "" });

    const viewed = t.view(next, "admin");
    expect(viewed.role).toBe("admin");
    expect(viewed.data).toEqual({ count: 5, name: "" });
  });

  it("testActor(contract) runtime: guard rejects unauthorized", async () => {
    const t = testActor(Counter);
    const state = t.init({ initial: 0 });

    // viewer should be rejected by ADMIN_ONLY guard
    await expect(t.send(state, "viewer-user", { type: "ADMIN_ONLY" })).rejects.toThrow("Guard rejected");
  });

  it("testActor(contract) runtime: sendWithEffects captures executions", async () => {
    const ExecutingCounter = defineActor("executing", {
      input: z.object({}),
      init: (): CounterState => ({ count: 0, name: "" }),
      roles: { user: () => true },
      messages: {
        NOTIFY: message(z.object({}), (state: CounterState, _payload, ctx) => {
          ctx.execute("NOTIFICATIONS", { count: state.count });
          return state;
        }),
      },
      views: {
        user: view(CounterView, (state: CounterState) => ({
          count: state.count,
          name: state.name,
        })),
      },
    });

    const t = testActor(ExecutingCounter);
    const state = t.init({});
    const { state: next, executions } = await t.sendWithEffects(state, "anyone", { type: "NOTIFY" });

    expect(next).toEqual(state);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toEqual({ service: "NOTIFICATIONS", payload: { count: 0 } });
  });

  it("testActor(contract) runtime: role resolution works", () => {
    const t = testActor(Counter);
    const state = t.init({ initial: 0 });

    expect(t.role(state, "admin")).toBe("admin");
    expect(t.role(state, "anyone-else")).toBe("viewer");
  });

  it("testActor(contract) runtime: viewer gets viewer view", () => {
    const t = testActor(Counter);
    const state = t.init({ initial: 42 });

    const result = t.view(state, "a-viewer");
    expect(result.role).toBe("viewer");
    expect(result.data).toEqual({ total: 42 });
  });
});
