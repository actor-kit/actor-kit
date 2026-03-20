/**
 * Minimal test worker for Miniflare integration tests.
 * Self-contained: no dependency on example apps.
 */
import { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { AnyActorServer } from "../../../packages/types/src/types";
import { createActorKitRouter, createMachineServer } from "../../../packages/worker/src/index";
import { WorkerEntrypoint } from "cloudflare:workers";
import { assign, setup } from "xstate";
import { z } from "zod";
import type {
  ActorKitSystemEvent,
  BaseActorKitEvent,
  WithActorKitEvent,
  WithActorKitInput,
} from "../../../packages/types/src/types";

// --- Schemas ---

const CounterClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("INCREMENT") }),
  z.object({ type: z.literal("DECREMENT") }),
  z.object({ type: z.literal("SET"), value: z.number() }),
]);

const CounterServiceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("RESET") }),
]);

const CounterInputPropsSchema = z.object({
  initialCount: z.number().optional(),
});

// --- Types ---

type CounterClientEvent = z.infer<typeof CounterClientEventSchema>;
type CounterServiceEvent = z.infer<typeof CounterServiceEventSchema>;
type CounterInputProps = z.infer<typeof CounterInputPropsSchema>;

interface Env {
  COUNTER: DurableObjectNamespace<InstanceType<typeof Counter>>;
  ACTOR_KIT_SECRET: string;
  [key: string]: DurableObjectNamespace<AnyActorServer> | unknown;
}

type CounterEvent = (
  | WithActorKitEvent<CounterClientEvent, "client">
  | WithActorKitEvent<CounterServiceEvent, "service">
  | ActorKitSystemEvent
) &
  BaseActorKitEvent<Env>;

type CounterInput = WithActorKitInput<CounterInputProps, Env>;

type CounterPublicContext = {
  count: number;
  lastUpdatedBy: string | null;
};

type CounterServerContext = {
  public: CounterPublicContext;
  private: Record<string, { accessCount: number }>;
};

// --- Machine ---

const counterMachine = setup({
  types: {
    context: {} as CounterServerContext,
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
    trackAccess: assign({
      private: ({ context, event }) => ({
        ...context.private,
        [event.caller.id]: {
          accessCount:
            (context.private[event.caller.id]?.accessCount ?? 0) + 1,
        },
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
        INCREMENT: { actions: ["increment", "trackAccess"] },
        DECREMENT: { actions: ["decrement", "trackAccess"] },
        SET: { actions: ["setValue", "trackAccess"] },
        RESET: { actions: ["resetCounter"] },
      },
    },
  },
});

// --- Server ---

export const Counter = createMachineServer({
  machine: counterMachine,
  schemas: {
    clientEvent: CounterClientEventSchema,
    serviceEvent: CounterServiceEventSchema,
    inputProps: CounterInputPropsSchema,
  },
  options: { persisted: true },
});

// --- Worker ---

const router = createActorKitRouter<Env>(["counter"]);

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
