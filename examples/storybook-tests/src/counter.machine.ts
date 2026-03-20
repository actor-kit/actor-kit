import type {
  ActorKitStateMachine,
  ActorKitSystemEvent,
  BaseActorKitEvent,
  CallerSnapshotFrom,
  WithActorKitEvent,
  WithActorKitInput,
} from "@actor-kit/types";

// --- Events ---
export type CounterClientEvent =
  | { type: "INCREMENT" }
  | { type: "DECREMENT" }
  | { type: "RESET" };

export type CounterServiceEvent = { type: "NOOP" };

interface CounterEnv {
  ACTOR_KIT_SECRET: string;
  [key: string]: unknown;
}

export type CounterEvent = (
  | WithActorKitEvent<CounterClientEvent, "client">
  | WithActorKitEvent<CounterServiceEvent, "service">
  | ActorKitSystemEvent
) &
  BaseActorKitEvent<CounterEnv>;

export type CounterInput = WithActorKitInput<Record<string, never>, CounterEnv>;

// --- Context ---
export type CounterContext = {
  public: { count: number };
  private: Record<string, Record<string, never>>;
};

// --- Machine type ---
export type CounterMachine = ActorKitStateMachine<
  CounterEvent,
  CounterInput,
  CounterContext
>;

// --- Snapshot helper ---
export type CounterSnapshot = CallerSnapshotFrom<CounterMachine>;
