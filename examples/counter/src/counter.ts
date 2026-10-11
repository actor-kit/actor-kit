// Counter actor contract — browser-safe (imports from @actor-kit/worker/testing, no cloudflare:workers).
// Used by both server (SSR loader, DO class) and client (typed React context, typed client).

import { z } from "zod";
import { nullable, schema, string, uint32, view } from "@actor-kit/core";
import { setup } from "@actor-kit/worker/testing";

type CounterState = { count: number; lastUpdatedBy: string | null };

export const CounterViewSchema = schema({ count: uint32, lastUpdatedBy: nullable(string) });

/** The kit (ADR-018 A): this actor declares no events, states or env, so it is empty. */
const counter = setup({});

export const CounterContract = counter.actor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastUpdatedBy: null }),

  roles: {
    admin: (
      _state: CounterState,
      _caller: string,
      { callerType }: { callerType: "user" | "service" },
    ) => callerType === "service",
    user: () => true,
  },

  messages: {
    INCREMENT: counter.message(
      z.object({}),
      (state: CounterState, _payload, { caller }) => ({
        ...state,
        count: state.count + 1,
        lastUpdatedBy: caller,
      }),
    ),
    DECREMENT: counter.message(
      z.object({}),
      (state: CounterState, _payload, { caller }) => ({
        ...state,
        count: Math.max(0, state.count - 1),
        lastUpdatedBy: caller,
      }),
    ),
    RESET: counter.message(z.object({}), {
      guard: (_state: CounterState, _payload: Record<string, never>, ctx: { role: string }) =>
        ctx.role === "admin",
      handler: () => ({ count: 0, lastUpdatedBy: null }),
    }),
  },

  views: {
    admin: view.shared(CounterViewSchema, (state: CounterState) => ({
      count: state.count,
      lastUpdatedBy: state.lastUpdatedBy,
    })),
    user: view.shared(CounterViewSchema, (state: CounterState) => ({
      count: state.count,
      lastUpdatedBy: state.lastUpdatedBy,
    })),
  },

  studio: { enabled: true },
});

export type CounterContract = typeof CounterContract;
