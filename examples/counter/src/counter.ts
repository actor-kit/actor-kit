import { z } from "zod";
import { schema, string, uint32, view } from "@actor-kit/core";
import { actor, message } from "@actor-kit/worker";

type CounterState = { count: number; lastUpdatedBy: string | null };

export const CounterView = schema({ count: uint32, lastUpdatedBy: string });

const increment = message(
  z.object({}),
  (state: CounterState, _payload, { caller }) => ({
    ...state,
    count: state.count + 1,
    lastUpdatedBy: caller,
  }),
);

const decrement = message(
  z.object({}),
  (state: CounterState, _payload, { caller }) => ({
    ...state,
    count: Math.max(0, state.count - 1),
    lastUpdatedBy: caller,
  }),
);

const reset = message(
  z.object({}),
  (state: CounterState) => ({ count: 0, lastUpdatedBy: null }),
);

export const Counter = actor("counter", {
  // JSON sync for simple browser clients (no bundled decoder needed)
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastUpdatedBy: null }),

  roles: {
    admin: (_state: CounterState, _caller: string, claims: { callerType: "user" | "service" }) =>
      claims.callerType === "service",
    user: () => true,
  },

  messages: {
    admin: { INCREMENT: increment, DECREMENT: decrement, RESET: reset },
    user: { INCREMENT: increment, DECREMENT: decrement },
  },

  views: {
    admin: view(CounterView, (state: CounterState) => ({
      count: state.count,
      lastUpdatedBy: state.lastUpdatedBy ?? "",
    })),
    user: view(CounterView, (state: CounterState) => ({
      count: state.count,
      lastUpdatedBy: state.lastUpdatedBy ?? "",
    })),
  },
});
