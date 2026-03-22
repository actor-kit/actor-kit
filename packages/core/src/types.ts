import type { z } from "zod";

/** Caller — discriminated union, no "system" type (lifecycle hooks instead) */
export type Caller =
  | { type: "client"; id: string }
  | { type: "service"; id: string };

/** Caller type string literal */
export type CallerType = Caller["type"];

/** Base env — must have ACTOR_KIT_SECRET for actor-to-actor auth */
export type BaseEnv = {
  ACTOR_KIT_SECRET: string;
  [key: string]: unknown;
};

/** The core contract — any state library must satisfy this */
export interface ActorLogic<
  TState,
  TEvent extends { type: string },
  TView,
  TEnv extends BaseEnv,
  TInput,
> {
  create(input: TInput, ctx: { id: string; caller: Caller; env: TEnv }): TState;
  transition(
    state: TState,
    event: TEvent & { caller: Caller; env: TEnv }
  ): TState;
  getView(state: TState, caller: Caller): TView;

  serialize(state: TState): unknown;
  restore(serialized: unknown): TState;
  version?: number;
  migrate?(serialized: unknown, version?: number): TState;

  onConnect?(state: TState, caller: Caller): TState;
  onDisconnect?(state: TState, caller: Caller): TState;
  onResume?(state: TState): TState;
}

/** Config for createDurableActor */
export interface DurableActorConfig<
  TState,
  TEvent extends { type: string },
  TView,
  TEnv extends BaseEnv,
  TInput,
> {
  logic: ActorLogic<TState, TEvent, TView, TEnv, TInput>;
  events: {
    client: z.ZodSchema;
    service: z.ZodSchema;
  };
  input: z.ZodSchema<TInput>;
  persisted?: boolean;
}

/** What the DO exposes via RPC */
export interface DurableActorMethods<TView> {
  spawn(props: {
    actorType: string;
    actorId: string;
    caller: Caller;
    input: Record<string, unknown>;
  }): Promise<void> | void;
  send(event: { type: string; caller: Caller; [key: string]: unknown }): void;
  getSnapshot(caller: Caller): Promise<{
    checksum: string;
    snapshot: TView;
  }>;
  fetch(request: Request): Promise<Response>;
}
