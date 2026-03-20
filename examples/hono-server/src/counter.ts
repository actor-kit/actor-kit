/**
 * Counter actor — a simple incrementable counter as a Durable Object.
 */
import type {
  ActorKitSystemEvent,
  AnyActorServer,
  BaseActorKitEvent,
  WithActorKitEvent,
  WithActorKitInput,
} from "@actor-kit/types";
import { createMachineServer } from "@actor-kit/worker";
import { assign, setup } from "xstate";
import { z } from "zod";

// --- Env ---

export interface Env {
  COUNTER: DurableObjectNamespace<InstanceType<typeof Counter>>;
  ACTOR_KIT_SECRET: string;
  [key: string]: DurableObjectNamespace<AnyActorServer> | unknown;
}

// --- Schemas ---

export const CounterClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("INCREMENT") }),
  z.object({ type: z.literal("DECREMENT") }),
  z.object({ type: z.literal("SET"), value: z.number() }),
]);

export const CounterServiceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("RESET") }),
]);

export const CounterInputPropsSchema = z.object({
  initialCount: z.number().optional(),
});

// --- Types ---

type CounterClientEvent = z.infer<typeof CounterClientEventSchema>;
type CounterServiceEvent = z.infer<typeof CounterServiceEventSchema>;

type CounterEvent = (
  | WithActorKitEvent<CounterClientEvent, "client">
  | WithActorKitEvent<CounterServiceEvent, "service">
  | ActorKitSystemEvent
) &
  BaseActorKitEvent<Env>;

type CounterInput = WithActorKitInput<
  z.infer<typeof CounterInputPropsSchema>,
  Env
>;

type CounterContext = {
  public: { count: number; lastUpdatedBy: string | null };
  private: Record<string, { accessCount: number }>;
};

// --- Machine ---

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
    decrement: assign({
      public: ({ context, event }) => ({
        ...context.public,
        count: context.public.count - 1,
        lastUpdatedBy: event.caller.id,
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
        DECREMENT: { actions: ["decrement"] },
        SET: { actions: ["setValue"] },
        RESET: { actions: ["resetCounter"] },
      },
    },
  },
});

export type CounterMachine = typeof counterMachine;

// --- Durable Object ---

export const Counter = createMachineServer({
  machine: counterMachine,
  schemas: {
    clientEvent: CounterClientEventSchema,
    serviceEvent: CounterServiceEventSchema,
    inputProps: CounterInputPropsSchema,
  },
  options: { persisted: true },
});
