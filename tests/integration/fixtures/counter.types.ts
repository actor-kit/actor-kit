/**
 * Shared types for the counter test machine.
 * Used by both the worker (fixtures/worker.ts) and integration tests.
 */
import type {
  ActorKitStateMachine,
  ActorKitSystemEvent,
  BaseActorKitEvent,
  WithActorKitEvent,
  WithActorKitInput,
} from "actor-kit";

// --- Client events (what createActorKitClient.send() accepts) ---

export type CounterClientEvent =
  | { type: "INCREMENT" }
  | { type: "DECREMENT" }
  | { type: "SET"; value: number };

export type CounterServiceEvent = { type: "RESET" };

export type CounterInputProps = { initialCount?: number };

// --- Env ---

export interface CounterEnv {
  ACTOR_KIT_SECRET: string;
  [key: string]: unknown;
}

// --- Aggregate event type (what the machine processes) ---

export type CounterEvent = (
  | WithActorKitEvent<CounterClientEvent, "client">
  | WithActorKitEvent<CounterServiceEvent, "service">
  | ActorKitSystemEvent
) &
  BaseActorKitEvent<CounterEnv>;

export type CounterInput = WithActorKitInput<CounterInputProps, CounterEnv>;

// --- Context ---

export type CounterPublicContext = {
  count: number;
  lastUpdatedBy: string | null;
};

export type CounterPrivateContext = {
  accessCount: number;
};

export type CounterServerContext = {
  public: CounterPublicContext;
  private: Record<string, CounterPrivateContext>;
};

// --- Machine type (satisfies ActorKitStateMachine constraint) ---

export type CounterMachine = ActorKitStateMachine<
  CounterEvent,
  CounterInput,
  CounterServerContext
>;
