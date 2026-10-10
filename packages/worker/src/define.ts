/**
 * defineActor() — creates a typed contract from an actor definition.
 *
 * The contract is NOT a DO class. It's a plain object that preserves
 * the full type information of the definition (TState, TInput, TMessages,
 * TRoles, TViews) via generics. Everything derives from the contract:
 *
 *   const Counter = defineActor("counter", { init, roles, messages, views });
 *   const CounterDO = createActorClass(Counter); // → DO class
 *
 * init() can be async — useful for fetching initial state from KV/D1/R2:
 *   init: async (input, env) => {
 *     const config = await env.KV.get("config", "json");
 *     return { ...config, count: 0 };
 *   }
 *
 * Type extraction:
 *   type State = Awaited<ReturnType<typeof Counter.def.init>>;
 *   type Roles = keyof typeof Counter.def.roles;
 *   type Messages = keyof typeof Counter.def.messages;
 */

import type { ChainIsTyped, CurrentState } from "./runtime/versions";

/**
 * A typed contract that preserves the full definition type.
 * TName is the actor name (string literal).
 * TDef is the exact type of the definition object.
 */
export interface ActorContract<TName extends string = string, TDef = unknown> {
  readonly name: TName;
  readonly def: TDef;
}

/**
 * Create a typed actor contract from a definition.
 * The contract preserves all type information for downstream consumers
 * (actorClient, actorContext, testActor, createRef).
 */
export function defineActor<
  TName extends string,
  TDef extends {
    input: import("zod").ZodType;
    init(...args: never[]): unknown;
  },
>(name: TName, def: TDef & VersionsCheck<TDef> & PublishCheck<TDef>): ActorContract<TName, TDef> {
  return { name, def };
}

/** ADR-017 §3: `publish.events` may only name events the actor declares in `events`. */
type PublishCheck<TDef> = TDef extends { publish: unknown }
  ? TDef extends { events: infer E }
    ? { publish: { queue: string; events: readonly (keyof E & string)[] } }
    : { publish: { queue: string; events: readonly never[] } }
  : unknown;

type InitState<TDef> = TDef extends { init(...args: never[]): infer S } ? Awaited<S> : never;

/**
 * ADR-015 D5: every step of `versions` must take the previous version's state, and the last
 * version must describe what init returns. A mismatch makes `versions` a type error.
 */
type VersionsCheck<TDef> = TDef extends { versions: infer V extends readonly unknown[] }
  ? ChainIsTyped<V> extends true
    ? [InitState<TDef>] extends [CurrentState<V>]
      ? unknown
      : { versions: "the last version's schema must describe the state init returns" }
    : { versions: "each version's state step must take the previous version's state" }
  : unknown;

/**
 * What lifecycle.connect / lifecycle.disconnect receive. Each socket is its own
 * connection, so these fire once per socket (tab). `callerConnections` is how many
 * sockets this caller (same caller + callerType) holds open after the event: it
 * includes the socket that just connected and excludes the one that just closed.
 * A caller's first connect sees 1; their last disconnect sees 0.
 */
export interface LifecycleEvent {
  caller: string;
  callerType: "user" | "service";
  callerConnections: number;
}
