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

import type { CancelFn, DeterministicContext, ExecuteFn, ForwardFn, ScheduleFn } from "@actor-kit/core";
import type { ZodType } from "zod";
import type { EffectInfo } from "./runtime/effect-info";
import type { BuiltInError } from "./runtime/service-error";
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
    input: ZodType;
    init(...args: never[]): unknown;
  },
  TState = unknown,
  TErrors extends Record<string, unknown> = Record<never, never>,
  TEnvSchema extends ZodType | undefined = undefined,
>(
  name: TName,
  def: TDef &
    VersionsCheck<TDef> &
    PublishCheck<TDef> & { env?: TEnvSchema } & TypedServices<TState, TErrors, EnvOf<TEnvSchema>>,
): ActorContract<TName, TDef> {
  return { name, def };
}

// --- Typed services (ADR-016) ---

/**
 * What a service's onError and `retry.while` receive: its declared errors (the `errors` schema's output)
 * plus the built-ins `{ _tag: "Timeout", ms }` and `{ _tag: "Defect", message }`. Only the built-ins when
 * it declares no `errors`.
 */
export type ServiceErrorOf<TDeclared> = unknown extends TDeclared ? BuiltInError : TDeclared | BuiltInError;

/** What handlers see as `env`: the `env` schema's output (ADR-016 §4), or `unknown` without one. */
export type EnvOf<TEnvSchema> = TEnvSchema extends ZodType<infer TEnv> ? TEnv : unknown;

/** What a service's onDone / onError get as their last argument. */
export type ServiceCallbackContext<TEnv = unknown> = DeterministicContext & { readonly env: TEnv };

/** What lifecycle.connect / disconnect get as ctx. */
export interface LifecycleContext<TEnv = unknown> extends DeterministicContext {
  readonly caller: string;
  readonly callerType: "user" | "service";
  readonly env: TEnv;
  readonly execute: ExecuteFn;
  readonly forward: ForwardFn;
  readonly schedule: ScheduleFn;
  readonly cancel: CancelFn;
}

/** A service's `retry` option, with `while` typed by its error union. */
export interface ServiceRetry<TError> {
  /** Total number of tries, including the first (default 3). */
  readonly attempts?: number;
  readonly backoff?: {
    readonly baseMs?: number;
    readonly factor?: number;
    readonly maxMs?: number;
    readonly jitter?: number;
  };
  /** Retry a failed try when this returns true. Default: the built-ins (Timeout, Defect) are, declared errors are not. */
  while?(error: TError): boolean;
}

/**
 * A service in the `services` block, as defineActor types it. Methods (not function properties), so a
 * handler may annotate a narrower input or result.
 */
export interface ServiceDef<TState, TDeclared = unknown, TEnv = unknown> {
  /** Declared failures: a `z.discriminatedUnion("_tag", [...])`. `throw fail(error)` values parse against it. */
  readonly errors?: ZodType<TDeclared>;
  /** The async work. `effect`: actor, effect id, idempotency key, try number, AbortSignal. */
  fn(input: unknown, env: TEnv, effect: EffectInfo): Promise<unknown>;
  readonly retry?: ServiceRetry<ServiceErrorOf<TDeclared>>;
  /** Time limit per try, in ms (default 30 000). On expiry `effect.signal` is aborted and the try is a Timeout. */
  readonly timeoutMs?: number;
  onDone?(state: TState, result: unknown, input: unknown, ctx: ServiceCallbackContext<TEnv>): TState;
  /** Runs once, after the last try failed (or at once for an error `retry.while` does not retry). */
  onError?(state: TState, error: ServiceErrorOf<TDeclared>, input: unknown, ctx: ServiceCallbackContext<TEnv>): TState;
}

/**
 * The typed parts of a definition: the state comes from init, each service's error union from its
 * `errors` (inferred per service, so every onError sees its own).
 */
type TypedServices<TState, TErrors, TEnv> = {
  init(...args: never[]): TState | PromiseLike<TState>;
  services?: { [K in keyof TErrors]: ServiceDef<TState, TErrors[K], TEnv> };
  lifecycle?: {
    connect?(state: TState, event: LifecycleEvent, ctx: LifecycleContext<TEnv>): TState;
    disconnect?(state: TState, event: LifecycleEvent, ctx: LifecycleContext<TEnv>): TState;
  };
};

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
