import { nullable, schema, string, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, message } from "@actor-kit/worker";
import { z } from "zod";

// --- Counter actor (v3: defineActor + flat messages + guards) ---

type CounterState = { count: number; lastCaller: string | null };

const CounterView = schema({ count: uint32, lastCaller: string });

const increment = message(
  z.object({ amount: z.number().int().positive() }),
  (state: CounterState, { amount }, { caller }) => ({
    count: state.count + amount,
    lastCaller: caller,
  }),
);

const decrement = message(z.object({ amount: z.number().int().positive() }), {
  guard: (_state: CounterState, _payload: { amount: number }, ctx: { role: string }) => ctx.role === "admin",
  handler: (state: CounterState, { amount }, { caller }) => ({
    count: state.count - amount,
    lastCaller: caller,
  }),
});

const reset = message(z.object({}), {
  guard: (_state: CounterState, _payload: Record<string, never>, ctx: { role: string }) => ctx.role === "admin",
  handler: (_state: CounterState) => ({ count: 0, lastCaller: null }),
});

const notify = message(z.object({}), {
  guard: (_state: CounterState, _payload: Record<string, never>, ctx: { role: string }) => ctx.role === "admin",
  handler: (
    state: CounterState,
    _payload: Record<string, never>,
    ctx: { execute: (service: string, input: unknown) => void },
  ) => {
    ctx.execute("ANALYTICS", { count: state.count });
    return state;
  },
});

const forwardTo = message(
  z.object({ targetId: z.string() }),
  (
    state: CounterState,
    { targetId }: { targetId: string },
    ctx: {
      forward: (linkName: string, targetId: string, message: { type: string; [key: string]: unknown }) => void;
    },
  ) => {
    ctx.forward("COUNTER", targetId, { type: "INCREMENT", amount: 5 });
    return state;
  },
);

const guardedAdd = message(z.object({ amount: z.number().int().positive() }), {
  guard: (state: CounterState, { amount }: { amount: number }) => state.count + amount <= 100,
  handler: (state: CounterState, { amount }, { caller }) => ({
    ...state,
    count: state.count + amount,
    lastCaller: caller,
  }),
});

const CounterContract = defineActor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastCaller: null }),
  roles: {
    admin: (_state: CounterState, _caller: string, { callerType }: { callerType: "user" | "service" }) =>
      callerType === "service",
    user: () => true,
  },
  messages: {
    INCREMENT: increment,
    DECREMENT: decrement,
    RESET: reset,
    NOTIFY: notify,
    GUARDED_ADD: guardedAdd,
    FORWARD_TO: forwardTo,
  },
  views: {
    admin: view.shared(CounterView, (state: CounterState) => ({
      count: state.count,
      lastCaller: state.lastCaller ?? "",
    })),
    user: view.shared(CounterView, (state: CounterState) => ({
      count: state.count,
      lastCaller: state.lastCaller ?? "",
    })),
  },
  studio: { enabled: true },
});

export const Counter = createActorClass(CounterContract);

// --- NullableCounter actor (tests nullable schema fields) ---

type NullableCounterState = { count: number; lastUpdatedBy: string | null };

const NullableCounterView = schema({ count: uint32, lastUpdatedBy: nullable(string) });

const setCount = message(
  z.object({ value: z.number().int() }),
  (state: NullableCounterState, { value }, { caller }) => ({
    count: value,
    lastUpdatedBy: caller,
  }),
);

const clearUpdater = message(z.object({}), (state: NullableCounterState) => ({
  ...state,
  lastUpdatedBy: null,
}));

const NullableCounterContract = defineActor("nullable-counter", {
  input: z.object({}),
  init: (): NullableCounterState => ({ count: 0, lastUpdatedBy: null }),
  roles: {
    user: () => true,
  },
  messages: {
    SET_COUNT: setCount,
    CLEAR_UPDATER: clearUpdater,
  },
  views: {
    user: view.shared(NullableCounterView, (state: NullableCounterState) => ({
      count: state.count,
      lastUpdatedBy: state.lastUpdatedBy,
    })),
  },
});

export const NullableCounter = createActorClass(NullableCounterContract);

// --- Worker entrypoint ---

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response("Actor Kit v3 test worker", { status: 200 });
  },
};
