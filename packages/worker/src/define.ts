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
import type { DeterminismMode } from "./runtime/determinism";
import type { EffectInfo } from "./runtime/effect-info";
import type { BuiltInError } from "./runtime/service-error";
import type { ChainIsTyped, CurrentState } from "./runtime/versions";
import type { EventPayloads, EventSchemas, KitActorDef, KitContractDef, Setup, StateDecls, TypedEmit } from "./setup";

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
 * Create a typed contract from a definition. The documented shape is `defineActor(name, kit, def)`
 * (the same as `kit.actor(name, def)`, ADR-018 A): the kit from `setup()` supplies the events, env and
 * states, and its helpers type every handler. `defineActor(name, def)` takes a whole definition.
 * The contract preserves all type information for downstream consumers (actorClient, actorContext,
 * testActor, simulate, createRef).
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
    PublishCheck<TDef> & { env?: TEnvSchema; determinism?: DeterminismMode } & TypedServices<
      TState,
      TErrors,
      EnvOf<TEnvSchema>,
      DefEvents<TDef>
    >,
): ActorContract<TName, TDef>;
export function defineActor<
  TName extends string,
  ES extends EventSchemas,
  SD extends StateDecls,
  TEnvSchema,
  TDef extends { input: ZodType; init(...args: never[]): unknown },
  TState = unknown,
  TErrors extends Record<string, unknown> = Record<never, never>,
>(
  name: TName,
  kit: Setup<ES, SD, TEnvSchema>,
  def: KitActorDef<TDef, TState, TErrors, ES, SD, TEnvSchema>,
): ActorContract<TName, KitContractDef<TDef, ES, TEnvSchema>>;
export function defineActor(name: string, defOrKit: unknown, def?: unknown): ActorContract<string, unknown> {
  if (isKit(defOrKit)) return defOrKit.actor(name, def);
  return { name, def: defOrKit };
}

/** A kit from setup() (it has `actor`); a definition does not. */
function isKit(value: unknown): value is { actor(name: string, def: unknown): ActorContract<string, unknown> } {
  return typeof value === "object" && value !== null && "actor" in value && typeof value.actor === "function";
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

/**
 * What a service's onDone / onError get as their last argument: the call's effect id (ADR-018 G) and
 * `emit` (ADR-018 F), typed by the actor's events when defined through a kit.
 */
export type ServiceCallbackContext<TEnv = unknown, E = Record<never, never>> = DeterministicContext & {
  readonly env: TEnv;
  /** The effect id ctx.execute() returned for this call. */
  readonly effectId: string;
  readonly emit: TypedEmit<E>;
};

/** What lifecycle.connect / disconnect get as ctx; `emit` is typed by the actor's events (ADR-018 F). */
export interface LifecycleContext<TEnv = unknown, E = Record<never, never>> extends DeterministicContext {
  readonly emit: TypedEmit<E>;
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
/**
 * A service. `R` is what its callbacks return (the state; for a kit with states, also stay/goto) and `C`
 * their ctx (for a kit with states, it adds the active path, `stay` and `goto`, ADR-019 B).
 */
export interface ServiceDef<
  TState,
  TDeclared = unknown,
  TEnv = unknown,
  TResult = unknown,
  E = Record<never, never>,
  R = TState,
  C = ServiceCallbackContext<TEnv, E>,
> {
  /** Declared failures: a `z.discriminatedUnion("_tag", [...])`. `throw fail(error)` values parse against it. */
  readonly errors?: ZodType<TDeclared>;
  /**
   * Parses `fn`'s return (ADR-018 G): only the parsed value is journaled and passed to onDone. A result that
   * does not parse fails the try as a Defect.
   */
  readonly result?: ZodType<TResult>;
  /** Largest result accepted, as JSON bytes (default 128 KiB); larger fails the try as a Defect. */
  readonly maxResultBytes?: number;
  /**
   * `"at-least-once"` (default): retried, and a try cut off by an eviction counts as an `Evicted` attempt.
   * `"at-most-once"`: tried once; a try cut off by an eviction becomes an `OutcomeUnknown` dead letter.
   */
  readonly delivery?: "at-least-once" | "at-most-once";
  /** The async work. `effect`: actor, effect id, idempotency key, try number, AbortSignal, record(). */
  fn(input: unknown, env: TEnv, effect: EffectInfo): Promise<unknown>;
  readonly retry?: ServiceRetry<ServiceErrorOf<TDeclared>>;
  /** Time limit per try, in ms (default 30 000). On expiry `effect.signal` is aborted and the try is a Timeout. */
  readonly timeoutMs?: number;
  onDone?(state: TState, result: TResult, input: unknown, ctx: C): R;
  /** Runs once, after the last try failed (or at once for an error `retry.while` does not retry). */
  onError?(state: TState, error: ServiceErrorOf<TDeclared>, input: unknown, ctx: C): R;
  /**
   * A result that arrived after the state owning the call (`execute(..., { scope: "state" })`) was left
   * (ADR-019 B). Without it, the late result is journaled as `service.stale` and ignored.
   */
  onStale?(state: TState, result: TResult, input: unknown, ctx: C): R;
}

/**
 * The typed parts of a definition: the state comes from init, each service's error union from its
 * `errors` (inferred per service, so every onError sees its own).
 */
export type TypedServices<TState, TErrors, TEnv, E = Record<never, never>, R = TState> = {
  init(...args: never[]): TState | PromiseLike<TState>;
  services?: { [K in keyof TErrors]: ServiceDef<TState, TErrors[K], TEnv, unknown, E, R> };
  lifecycle?: {
    connect?(state: TState, event: LifecycleEvent, ctx: LifecycleContext<TEnv, E>): TState;
    disconnect?(state: TState, event: LifecycleEvent, ctx: LifecycleContext<TEnv, E>): TState;
  };
};

/** The payload type of each event a definition declares (none without `events`). */
type DefEvents<TDef> = TDef extends { events: infer ES extends EventSchemas }
  ? EventPayloads<ES>
  : Record<never, never>;

/**
 * ADR-017 §3: `publish.events` may only name events the actor declares in `events`. With a typed
 * `env` (ADR-016 §4), `publish.queue` must be one of its bindings: the parsed env keeps only those.
 */
export type PublishCheck<TDef> = TDef extends { publish: unknown }
  ? { publish: { queue: PublishQueue<TDef>; events: readonly PublishEvents<TDef>[] } }
  : unknown;

type PublishEvents<TDef> = TDef extends { events: infer E } ? keyof E & string : never;

type PublishQueue<TDef> = TDef extends { env: ZodType<infer TEnv> } ? keyof TEnv & string : string;

type InitState<TDef> = TDef extends { init(...args: never[]): infer S } ? Awaited<S> : never;

/**
 * ADR-015 D5: every step of `versions` must take the previous version's state, and the last
 * version must describe what init returns. A mismatch makes `versions` a type error.
 */
export type VersionsCheck<TDef> = TDef extends { versions: infer V extends readonly unknown[] }
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
