/**
 * Counter using fromXStateStore adapter.
 */
import { fromXStateStore } from "../../../packages/xstate-store/src/fromXStateStore";
import { createDurableActor, type BaseEnv, type Caller } from "../../../packages/core/src/index";
import { z } from "zod";

// --- Env ---

export interface Env extends BaseEnv {
  COUNTER: DurableObjectNamespace<InstanceType<typeof Counter>>;
}

// --- View ---

export type CounterView = {
  count: number;
  myAccessCount: number;
};

// --- Logic ---

const counterLogic = fromXStateStore<
  { count: number; accessCounts: Record<string, number> },
  CounterView,
  Env
>(
  {
    context: { count: 0, accessCounts: {} },
    on: {
      INCREMENT: (ctx, event: { caller: Caller; env: Env }) => ({
        ...ctx,
        count: ctx.count + 1,
        accessCounts: {
          ...ctx.accessCounts,
          [event.caller.id]: (ctx.accessCounts[event.caller.id] ?? 0) + 1,
        },
      }),
      DECREMENT: (ctx, event: { caller: Caller; env: Env }) => ({
        ...ctx,
        count: ctx.count - 1,
        accessCounts: {
          ...ctx.accessCounts,
          [event.caller.id]: (ctx.accessCounts[event.caller.id] ?? 0) + 1,
        },
      }),
      RESET: (ctx, event: { caller: Caller; env: Env }) => {
        if (event.caller.type !== "service") return ctx;
        return { ...ctx, count: 0 };
      },
    },
  },
  {
    getView: (state, caller) => ({
      count: state.count,
      myAccessCount: state.accessCounts[caller.id] ?? 0,
    }),
  }
);

// --- Durable Object ---

export const Counter = createDurableActor({
  logic: counterLogic,
  events: {
    client: z.discriminatedUnion("type", [
      z.object({ type: z.literal("INCREMENT") }),
      z.object({ type: z.literal("DECREMENT") }),
    ]),
    service: z.discriminatedUnion("type", [
      z.object({ type: z.literal("RESET") }),
    ]),
  },
  input: z.object({}),
  persisted: true,
});
