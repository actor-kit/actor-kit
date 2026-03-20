/**
 * Tests for the pure transition() API.
 *
 * These test state transitions as pure functions — no DO, no WebSocket,
 * no storage infrastructure required.
 */
import { describe, expect, it } from "vitest";
import { assign, setup } from "xstate";
import { transition } from "@actor-kit/test";
import type {
  ActorKitSystemEvent,
  BaseActorKitEvent,
  WithActorKitEvent,
  WithActorKitInput,
} from "@actor-kit/types";

// ---------------------------------------------------------------------------
// Test machine: a simple counter with public/private context
// ---------------------------------------------------------------------------

interface CounterEnv {
  ACTOR_KIT_SECRET: string;
  [key: string]: unknown;
}

type CounterClientEvent =
  | { type: "INCREMENT" }
  | { type: "SET"; value: number };

type CounterServiceEvent = { type: "RESET" };

type CounterEvent = (
  | WithActorKitEvent<CounterClientEvent, "client">
  | WithActorKitEvent<CounterServiceEvent, "service">
  | ActorKitSystemEvent
) &
  BaseActorKitEvent<CounterEnv>;

type CounterInput = WithActorKitInput<
  { initialCount?: number },
  CounterEnv
>;

type CounterContext = {
  public: { count: number; lastUpdatedBy: string | null };
  private: Record<string, { accessCount: number }>;
};

const counterMachine = setup({
  types: {
    context: {} as CounterContext,
    events: {} as CounterEvent,
    input: {} as CounterInput,
  },
  actions: {
    increment: assign({
      public: ({ context, event }) => ({
        ...context.public,
        count: context.public.count + 1,
        lastUpdatedBy: event.caller.id,
      }),
      private: ({ context, event }) => ({
        ...context.private,
        [event.caller.id]: {
          accessCount:
            (context.private[event.caller.id]?.accessCount ?? 0) + 1,
        },
      }),
    }),
    setValue: assign({
      public: ({ context, event }) => {
        if (event.type !== "SET") return context.public;
        return {
          ...context.public,
          count: event.value,
          lastUpdatedBy: event.caller.id,
        };
      },
    }),
    resetCounter: assign({
      public: ({ context }) => ({
        ...context.public,
        count: 0,
        lastUpdatedBy: null,
      }),
    }),
  },
}).createMachine({
  id: "counter",
  type: "parallel",
  context: ({ input }: { input: CounterInput }) => ({
    public: {
      count: input.initialCount ?? 0,
      lastUpdatedBy: null,
    },
    private: {},
  }),
  states: {
    Operations: {
      on: {
        INCREMENT: { actions: ["increment"] },
        SET: { actions: ["setValue"] },
        RESET: { actions: ["resetCounter"] },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("transition()", () => {
  it("applies a client event and returns the next snapshot", () => {
    const result = transition(counterMachine, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(result.context.public.count).toBe(1);
    expect(result.context.public.lastUpdatedBy).toBe("user-1");
  });

  it("provides a caller-scoped snapshot", () => {
    const result = transition(counterMachine, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(result.callerSnapshot.public.count).toBe(1);
    expect(result.callerSnapshot.private.accessCount).toBe(1);
    expect(result.callerSnapshot.value).toBeDefined();
  });

  it("returns only the caller's private context, not other callers", () => {
    // First: user-1 increments
    const after1 = transition(counterMachine, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    // Second: user-2 increments, starting from after1's snapshot
    const after2 = transition(counterMachine, {
      snapshot: after1.snapshot,
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-2" },
    });

    // user-2's caller snapshot should show user-2's private context
    expect(after2.callerSnapshot.private.accessCount).toBe(1);
    // Full context should show both callers
    expect(after2.context.private["user-1"]?.accessCount).toBe(1);
    expect(after2.context.private["user-2"]?.accessCount).toBe(1);
    expect(after2.context.public.count).toBe(2);
  });

  it("accepts a service event", () => {
    // Start with count=5
    const initial = transition(counterMachine, {
      event: { type: "SET", value: 5 },
      caller: { type: "client", id: "user-1" },
    });

    // Reset via service event
    const result = transition(counterMachine, {
      snapshot: initial.snapshot,
      event: { type: "RESET" },
      caller: { type: "service", id: "admin" },
    });

    expect(result.context.public.count).toBe(0);
    expect(result.context.public.lastUpdatedBy).toBeNull();
  });

  it("starts from default context when no snapshot is provided", () => {
    const result = transition(counterMachine, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    // Started from 0, incremented to 1
    expect(result.context.public.count).toBe(1);
  });

  it("starts from a provided snapshot", () => {
    // Build a snapshot with count=10
    const base = transition(counterMachine, {
      event: { type: "SET", value: 10 },
      caller: { type: "client", id: "user-1" },
    });

    // Increment from that snapshot
    const result = transition(counterMachine, {
      snapshot: base.snapshot,
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(result.context.public.count).toBe(11);
  });

  it("provides mock env with ACTOR_KIT_SECRET", () => {
    // The machine receives env via event augmentation.
    // transition() should provide a mock env that satisfies ActorKitEnv.
    // If the machine didn't throw, it means env was provided correctly.
    const result = transition(counterMachine, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(result.context.public.count).toBe(1);
  });

  it("accepts custom input props", () => {
    const result = transition(counterMachine, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
      input: { initialCount: 100 },
    });

    expect(result.context.public.count).toBe(101);
  });

  it("returns the XState state value", () => {
    const result = transition(counterMachine, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(result.callerSnapshot.value).toEqual({ Operations: {} });
  });

  it("returns the raw XState snapshot for chaining", () => {
    const first = transition(counterMachine, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    const second = transition(counterMachine, {
      snapshot: first.snapshot,
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(second.context.public.count).toBe(2);
    expect(second.context.private["user-1"]?.accessCount).toBe(2);
  });

  it("provides empty private context for callers with no private data", () => {
    const result = transition(counterMachine, {
      event: { type: "SET", value: 42 },
      caller: { type: "client", id: "user-1" },
    });

    // SET action doesn't write to private context, so user-1 has no entry
    expect(result.callerSnapshot.private).toEqual({});
  });

  it("provides mock env with ACTOR_KIT_SECRET to the machine", () => {
    // Build a machine that reads env.ACTOR_KIT_SECRET in an action
    const envReadingMachine = setup({
      types: {
        context: {} as {
          public: { secret: string };
          private: Record<string, never>;
        },
        events: {} as CounterEvent,
        input: {} as CounterInput,
      },
      actions: {
        readSecret: assign({
          public: ({ event }) => ({
            secret: (event as unknown as { env: { ACTOR_KIT_SECRET: string } }).env.ACTOR_KIT_SECRET,
          }),
        }),
      },
    }).createMachine({
      id: "env-reader",
      initial: "idle",
      context: () => ({ public: { secret: "" }, private: {} }),
      states: {
        idle: {
          on: { INCREMENT: { actions: "readSecret" } },
        },
      },
    });

    const result = transition(envReadingMachine, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    // The mock env provides "test-secret" as ACTOR_KIT_SECRET
    expect(result.context.public.secret).toBe("test-secret");
  });

  it("provides undefined for unknown env properties", () => {
    // Build a machine that reads an undefined env property
    const envReadingMachine = setup({
      types: {
        context: {} as {
          public: { envValue: unknown };
          private: Record<string, never>;
        },
        events: {} as CounterEvent,
        input: {} as CounterInput,
      },
      actions: {
        readUnknown: assign({
          public: ({ event }) => ({
            envValue: (event as unknown as { env: Record<string, unknown> }).env.NONEXISTENT,
          }),
        }),
      },
    }).createMachine({
      id: "env-unknown",
      initial: "idle",
      context: () => ({ public: { envValue: "initial" }, private: {} }),
      states: {
        idle: {
          on: { INCREMENT: { actions: "readUnknown" } },
        },
      },
    });

    const result = transition(envReadingMachine, {
      event: { type: "INCREMENT" },
      caller: { type: "client", id: "user-1" },
    });

    expect(result.context.public.envValue).toBeUndefined();
  });
});
