/**
 * Test worker with two DOs: Counter and Aggregator.
 * Aggregator uses fromActorKit to connect to Counter,
 * demonstrating DO-to-DO communication.
 */
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type {
  ActorKitSystemEvent,
  AnyActorServer,
  BaseActorKitEvent,
  CallerSnapshotFrom,
  WithActorKitEvent,
  WithActorKitInput,
} from "actor-kit";
import {
  createActorKitRouter,
  createMachineServer,
  fromActorKit,
} from "actor-kit/worker";
import { WorkerEntrypoint } from "cloudflare:workers";
import { assign, sendTo, setup } from "xstate";
import { z } from "zod";

// ============================================================================
// Env
// ============================================================================

interface Env {
  COUNTER: DurableObjectNamespace<InstanceType<typeof Counter>>;
  AGGREGATOR: DurableObjectNamespace<InstanceType<typeof Aggregator>>;
  ACTOR_KIT_SECRET: string;
  [key: string]: DurableObjectNamespace<AnyActorServer> | unknown;
}

// ============================================================================
// Counter DO (the "child" actor)
// ============================================================================

const CounterClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("INCREMENT") }),
]);

const CounterServiceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("INCREMENT") }),
]);

const CounterInputPropsSchema = z.object({});

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

type CounterServerContext = {
  public: { count: number };
  private: Record<string, never>;
};

const counterMachine = setup({
  types: {
    context: {} as CounterServerContext,
    events: {} as CounterEvent,
    input: {} as CounterInput,
  },
  actions: {
    increment: assign({
      public: ({ context }) => ({
        count: context.public.count + 1,
      }),
    }),
  },
}).createMachine({
  id: "counter",
  initial: "active",
  context: () => ({
    public: { count: 0 },
    private: {},
  }),
  states: {
    active: {
      on: {
        INCREMENT: { actions: "increment" },
      },
    },
  },
});

type CounterMachine = typeof counterMachine;

export const Counter = createMachineServer({
  machine: counterMachine,
  schemas: {
    clientEvent: CounterClientEventSchema,
    serviceEvent: CounterServiceEventSchema,
    inputProps: CounterInputPropsSchema,
  },
  options: { persisted: true },
});

// ============================================================================
// Aggregator DO (connects to Counter via fromActorKit)
// ============================================================================

const AggregatorClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("INCREMENT_COUNTER") }),
]);

const AggregatorServiceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("NOOP") }),
]);

const AggregatorInputPropsSchema = z.object({});

type AggregatorClientEvent = z.infer<typeof AggregatorClientEventSchema>;
type AggregatorServiceEvent = z.infer<typeof AggregatorServiceEventSchema>;

type CounterUpdatedEvent = {
  type: "COUNTER_UPDATED";
  actorType: "counter";
  actorId: string;
  snapshot: CallerSnapshotFrom<CounterMachine>;
  operations: unknown[];
};

type AggregatorEvent = (
  | WithActorKitEvent<AggregatorClientEvent, "client">
  | WithActorKitEvent<AggregatorServiceEvent, "service">
  | ActorKitSystemEvent
  | CounterUpdatedEvent
) &
  BaseActorKitEvent<Env>;

type AggregatorInput = WithActorKitInput<
  z.infer<typeof AggregatorInputPropsSchema>,
  Env
>;

type AggregatorServerContext = {
  public: {
    counterCount: number;
    counterId: string;
  };
  private: Record<string, never>;
};

const aggregatorMachine = setup({
  types: {
    context: {} as AggregatorServerContext,
    events: {} as AggregatorEvent,
    input: {} as AggregatorInput,
  },
  actors: {
    counterConnection: fromActorKit<CounterMachine>("counter"),
  },
  actions: {
    updateCounterSnapshot: assign({
      public: ({ context, event }) => {
        if (event.type !== "COUNTER_UPDATED") return context.public;
        const snapshot = (event as CounterUpdatedEvent).snapshot as {
          public: { count: number };
        };
        return {
          ...context.public,
          counterCount: snapshot.public.count,
        };
      },
    }),
    forwardIncrement: sendTo("counterConnection", { type: "INCREMENT" }),
  },
}).createMachine({
  id: "aggregator",
  initial: "active",
  context: ({ input }) => ({
    public: {
      counterCount: 0,
      // Deterministic counter ID based on aggregator ID
      counterId: `counter-for-${input.id}`,
    },
    private: {},
  }),
  states: {
    active: {
      // Invoke the counter connection — runs for the lifetime of this state
      invoke: {
        id: "counterConnection",
        src: "counterConnection",
        // input function receives the xstate.init event with our actor input
        input: ({ context, event }) => {
          const machineInput = (event as unknown as { input: AggregatorInput })
            .input;
          return {
            server: machineInput.env.COUNTER,
            actorId: context.public.counterId,
            actorInput: {},
            caller: { id: "aggregator", type: "service" as const },
            signingKey: machineInput.env.ACTOR_KIT_SECRET,
            eventSchema: CounterServiceEventSchema,
          };
        },
      },
      on: {
        COUNTER_UPDATED: {
          actions: "updateCounterSnapshot",
        },
        INCREMENT_COUNTER: {
          actions: "forwardIncrement",
        },
      },
    },
  },
});

export const Aggregator = createMachineServer({
  machine: aggregatorMachine,
  schemas: {
    clientEvent: AggregatorClientEventSchema,
    serviceEvent: AggregatorServiceEventSchema,
    inputProps: AggregatorInputPropsSchema,
  },
  options: { persisted: true },
});

// ============================================================================
// Worker
// ============================================================================

const router = createActorKitRouter<Env>(["counter", "aggregator"]);

export default class Worker extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    if (url.pathname.startsWith("/api/")) {
      return router(request, this.env, this.ctx);
    }
    return new Response("Test worker", { status: 200 });
  }
}
