import { z } from "zod";
import { schema, string, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, message } from "@actor-kit/worker";

type CounterState = { count: number; lastUpdatedBy: string | null };

export const CounterView = schema({ count: uint32, lastUpdatedBy: string });

export const CounterContract = defineActor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastUpdatedBy: null }),
  // Origin validation — prevents cross-site WebSocket CSRF
  // In production, set to your actual domain(s)
  allowedOrigins: ["http://localhost:8787", "http://localhost:8799"],

  roles: {
    admin: (
      _state: CounterState,
      _caller: string,
      { callerType }: { callerType: "user" | "service" },
    ) => callerType === "service",
    user: () => true,
  },

  messages: {
    INCREMENT: message(
      z.object({}),
      (state: CounterState, _payload, { caller }) => ({
        ...state,
        count: state.count + 1,
        lastUpdatedBy: caller,
      }),
    ),
    DECREMENT: message(
      z.object({}),
      (state: CounterState, _payload, { caller }) => ({
        ...state,
        count: Math.max(0, state.count - 1),
        lastUpdatedBy: caller,
      }),
    ),
    RESET: message(z.object({}), {
      guard: (_state: CounterState, _payload: Record<string, never>, ctx: { role: string }) =>
        ctx.role === "admin",
      handler: () => ({ count: 0, lastUpdatedBy: null }),
    }),
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

export const Counter = createActorClass(CounterContract);
