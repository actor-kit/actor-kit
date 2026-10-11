/**
 * setup() — the kit of an actor (ADR-017, ADR-018 A): what it declares up front, the typed helpers,
 * and `kit.actor()`, the one documented way to define it.
 *
 *   const quiz = setup({
 *     events: { RoundStarted: z.object({ n: z.number() }) },
 *     states: { lobby: {}, round: { local: RoundLocal, input: z.object({ n: z.number() }) }, reveal: {} },
 *   });
 *   const lobby = quiz.in("lobby");
 *   const round = quiz.in("round");
 *   export const Quiz = quiz.actor("quiz", {
 *     initial: "lobby",
 *     states: {
 *       lobby: lobby.state({ messages: { START: lobby.message(z.object({}), (s: S, _p, ctx) => ctx.goto("round", s, { n: 1 })) } }),
 *       round: round.state({ enter: (s: S, { n }, ctx) => ({ n, answers: {} }), messages: { ... }, timers: { ... } }),
 *       reveal: quiz.in("reveal").state({}),
 *     },
 *     ...
 *   });
 *
 * A `message()` handler defined inline cannot see the actor's `events` or `states` (TypeScript does
 * not infer a nested generic call from its siblings), so the typed `emit`, `local`, `stay`, `goto`
 * and `env` come from helpers bound to the declarations, like XState's `setup()`. Everything is also
 * checked at runtime: emitted payloads and locals are parsed by their schemas.
 */

import type { GuardContext, MessageContext, MessageDef, TimerContext, TimerDef } from "@actor-kit/core";
import type { z } from "zod";
import type {
  ActorContract,
  PublishCheck,
  ServiceCallbackContext,
  ServiceDef,
  ServiceErrorOf,
  ServiceRetry,
  TypedServices,
  VersionsCheck,
} from "./define";
import { type LinkDef, type LinkHandlers, link } from "./link";
import type { DeterminismMode } from "./runtime/determinism";
import type { EffectInfo } from "./runtime/effect-info";
import { goto as gotoPhase, PhaseTransition, pathOf, stay as stayInPhase } from "./runtime/phases";
import type {
  DeclAt,
  InputArgs,
  InputOf,
  LocalOf,
  MergedLocal,
  ParentOf,
  PathOf,
  PathsUnder,
  PhasedState,
  StateDecl,
  StateDecls,
  TargetOf,
} from "./state-paths";

export { PhaseTransition };

export type EventSchemas = Record<string, z.ZodType>;

/** Payload type of each declared event. */
export type EventPayloads<T extends EventSchemas> = { [K in keyof T]: z.output<T[K]> };

/** emit() typed by an actor's declared events. */
export type TypedEmit<E> = <K extends keyof E & string>(name: K, payload: E[K]) => void;

export type {
  DeclAt,
  InputArgs,
  InputOf,
  LeafPathsOf,
  LocalOf,
  LocalsAlong,
  Matching,
  MergedLocal,
  MergeLocals,
  PathOf,
  PathsOf,
  PhasedState,
  StateDecl,
  StateDecls,
  StatePath,
  TargetOf,
} from "./state-paths";

/** `goto(target, shared, input?)`: the target is a declared state's name or path; its input is checked. */
export type Goto<SD extends StateDecls, S> = <const T extends TargetOf<SD>>(
  target: T,
  shared: S,
  ...input: InputArgs<DeclAt<SD, PathOf<T>>>
) => PhaseTransition<S>;

/** What a handler returns in an actor with states: the next shared state (stay), or stay/goto. */
export type PhaseResult<S> = S | PhaseTransition<S>;

type Base<Ctx> = Omit<Ctx, "emit">;

export type EmittingMessageContext<TEnv, E> = Base<MessageContext<TEnv>> & { readonly emit: TypedEmit<E> };
export type EmittingTimerContext<TEnv, E> = Base<TimerContext<TEnv>> & { readonly emit: TypedEmit<E> };

/** `ctx.stay(shared, local?)` at path P: the local is the merged local of P and its ancestors. */
type StayAt<SD, P, S> = (
  shared: S,
  ...local: MergedLocal<SD, P> extends null ? [] : [local?: MergedLocal<SD, P>]
) => PhaseTransition<S>;

/** The phase part of a handler's context, for a handler declared at path P. */
export interface PhaseContext<SD extends StateDecls, P, S> {
  /** The active path: P or one of its leaves. */
  readonly phase: PathsUnder<SD, P>;
  /** The merged local of P and its ancestors. */
  readonly local: MergedLocal<SD, P>;
  readonly stay: StayAt<SD, P, S>;
  readonly goto: Goto<SD, S>;
}

type Handler<S, P, Ctx, R = S> = (state: S, payload: P, ctx: Ctx) => R;
type Guard<S, P, Ctx> = (state: S, payload: P, ctx: Ctx) => boolean;

/**
 * A message or timer of a state. Its handler is a method (checked bivariantly), so the typed
 * context it was written against fits the runtime's, which passes phase, local, stay and goto.
 */
export interface PhaseMessageDef<S, P> {
  readonly schema: z.ZodType<P>;
  handler(state: S, payload: P, ctx: never): PhaseResult<S>;
  guard?(state: S, payload: P, ctx: never): boolean;
}

export interface PhaseTimerDef<S, P> {
  readonly schema: z.ZodType<P>;
  handler(state: S, payload: P, ctx: never): PhaseResult<S>;
}

type HookContext<TEnv, E> = Omit<Base<TimerContext<TEnv>>, "key" | "lateBy"> & { readonly emit: TypedEmit<E> };

/**
 * What `enter` gets: the effect verbs, the path being entered, the merged local of the levels above it
 * (entered first), and `stay(shared, local)` to change the shared state as it builds its local.
 */
export type EnterContext<TEnv, E, SD extends StateDecls, P, S> = HookContext<TEnv, E> & {
  readonly phase: P;
  readonly local: MergedLocal<SD, ParentOf<P>>;
  stay(
    shared: S,
    ...local: LocalOf<DeclAt<SD, P>> extends null ? [] : [local: LocalOf<DeclAt<SD, P>>]
  ): PhaseTransition<S>;
};

/** What `exit` gets: the effect verbs, the path being left and its merged local (dropped after exit). */
export type ExitContext<TEnv, E, SD extends StateDecls, P> = HookContext<TEnv, E> & {
  readonly phase: P;
  readonly local: MergedLocal<SD, P>;
};

/** Any message or timer of a state with shared state S, whatever its payload (for `states` records). */
export interface StatePart<S> {
  readonly schema: { safeParse(data: unknown): unknown };
  handler(state: S, payload: never, ctx: never): PhaseResult<S>;
}

/** A state, as the actor's `states` holds it. */
export interface StateDef<S> {
  readonly local?: z.ZodType;
  enter?(shared: S, input: never, ctx: never): unknown;
  exit?(shared: S, ctx: never): S;
  readonly messages?: Record<string, StatePart<S>>;
  readonly timers?: Record<string, StatePart<S>>;
  readonly initial?: string;
  readonly states?: Record<string, unknown>;
}

/**
 * A state as `kit.in(path).state()` returns it: its messages keep their names and payloads, its child
 * states keep their types, and the phantom `~local` (never set at runtime) carries the local's type, so
 * contract-level types (typed client `send`, testActor/simulate snapshots) see them (ADR-018 B, D).
 */
export type TypedStateDef<S, L, M, NS = never> = Omit<StateDef<S>, "messages" | "states"> & {
  readonly messages?: M;
  readonly states?: NS;
  readonly "~local"?: L;
};

/** A parent state names its `initial` child and defines every child; a leaf has neither. */
export type ChildCheck<D> = D extends { readonly states: infer C }
  ? { initial: keyof C & string; states: { [K in keyof C]: unknown } }
  : { initial?: never; states?: never };

type PhaseCtx<TEnv, E, SD extends StateDecls, P, S> = EmittingMessageContext<TEnv, E> & PhaseContext<SD, P, S>;
type PhaseTimerCtx<TEnv, E, SD extends StateDecls, P, S> = EmittingTimerContext<TEnv, E> & PhaseContext<SD, P, S>;
type PhaseGuardCtx<TEnv, SD extends StateDecls, P> = GuardContext<TEnv> & {
  readonly phase: PathsUnder<SD, P>;
  readonly local: MergedLocal<SD, P>;
};

/**
 * The typed helpers of one state, at path P (`kit.in("round")`, `kit.in(["playing", "window"])`).
 * Exported so a helper shared by several states can be typed by it (Run Set Jimmy feedback 10).
 */
export interface PhaseHelpers<SD extends StateDecls, E, P, TEnvDefault = unknown> {
  message<Pay, S, TEnv = TEnvDefault>(
    schema: z.ZodType<Pay>,
    handler:
      | Handler<S, Pay, PhaseCtx<TEnv, E, SD, P, S>, PhaseResult<S>>
      | {
          guard: Guard<S, Pay, PhaseGuardCtx<TEnv, SD, P>>;
          handler: Handler<S, Pay, PhaseCtx<TEnv, E, SD, P, S>, PhaseResult<S>>;
        },
  ): PhaseMessageDef<S, Pay>;
  timer<Pay, S, TEnv = TEnvDefault>(
    schema: z.ZodType<Pay>,
    handler: Handler<S, Pay, PhaseTimerCtx<TEnv, E, SD, P, S>, PhaseResult<S>>,
  ): PhaseTimerDef<S, Pay>;
  /**
   * The state's behaviour. Its messages keep their names and payloads, so the typed client `send` lists
   * them (ADR-018 B); a parent names its `initial` child and defines each child state.
   */
  state<
    S,
    TEnv = TEnvDefault,
    const M extends Record<string, StatePart<S>> = Record<never, never>,
    const NS extends Record<string, unknown> = never,
  >(
    def: {
      enter?: (
        shared: S,
        input: InputOf<DeclAt<SD, P>>,
        ctx: EnterContext<TEnv, E, SD, P, S>,
      ) => LocalOf<DeclAt<SD, P>> | PhaseTransition<S>;
      exit?: (shared: S, ctx: ExitContext<TEnv, E, SD, P>) => S;
      messages?: M;
      timers?: Record<string, StatePart<S>>;
      initial?: string;
      states?: NS;
    } & ChildCheck<DeclAt<SD, P>>,
  ): TypedStateDef<S, LocalOf<DeclAt<SD, P>>, M, NS>;
}

/** What handlers see as `ctx.env`: the `env` schema's output (ADR-016 §4), or `unknown` without one. */
export type SetupEnv<TEnvSchema> = TEnvSchema extends z.ZodType<infer TEnv> ? TEnv : unknown;

export interface Setup<ES extends EventSchemas, SD extends StateDecls, TEnvSchema = undefined> {
  /** The declared events, for the actor's `events`. */
  readonly events: ES;
  /** The declared states (schemas only; behaviour goes in the actor's `states`), if any. */
  readonly states: SD | undefined;
  /** The declared env schema (ADR-016 §4), for the actor's `env`; it types ctx.env in every helper. */
  readonly env: TEnvSchema;
  message<P, S, TEnv = SetupEnv<TEnvSchema>>(
    schema: z.ZodType<P>,
    handler:
      | Handler<S, P, EmittingMessageContext<TEnv, EventPayloads<ES>>>
      | {
          guard: Guard<S, P, GuardContext<TEnv>>;
          handler: Handler<S, P, EmittingMessageContext<TEnv, EventPayloads<ES>>>;
        },
  ): MessageDef<S, P, TEnv>;
  timer<P, S, TEnv = SetupEnv<TEnvSchema>>(
    schema: z.ZodType<P>,
    handler: Handler<S, P, EmittingTimerContext<TEnv, EventPayloads<ES>>>,
  ): TimerDef<S, P, TEnv>;
  /**
   * A service (ADR-016, ADR-018 G) typed by the kit: `fn`'s env, onDone's `result` (the `result` schema's
   * output), onError's error union (its `errors` plus the built-ins) and both callbacks' ctx (env, effectId).
   */
  service<S, TResult = unknown, TDeclared = unknown>(
    def: KitServiceDef<S, TResult, TDeclared, SetupEnv<TEnvSchema>, EventPayloads<ES>>,
  ): ServiceDef<S, TDeclared, SetupEnv<TEnvSchema>, TResult, EventPayloads<ES>>;
  /** A link (ADR-011) whose callbacks' ctx.emit is typed by the kit's events (ADR-018 F). */
  link<
    TContract extends { readonly name: string; readonly def: Record<string, unknown> },
    TState = unknown,
    TView = unknown,
  >(
    contract: TContract,
    handlers: LinkHandlers<TState, TView, EventPayloads<ES>>,
  ): LinkDef<TContract, TView, TState, EventPayloads<ES>>;
  /**
   * Helpers for one declared state, by name (`"round"`) or path (`["playing", "window"]`): its
   * messages, timers, `enter` and `exit` see its typed (merged) local.
   */
  in<const T extends TargetOf<SD>>(target: T): PhaseHelpers<SD, EventPayloads<ES>, PathOf<T>, SetupEnv<TEnvSchema>>;
  /**
   * Define the actor (ADR-018 A): the kit supplies `events`, `env` and the states' declarations, so the
   * definition holds only behaviour. Same as `defineActor(name, kit, def)`.
   */
  actor<
    TName extends string,
    TDef extends { input: z.ZodType; init(...args: never[]): unknown },
    TState = unknown,
    TErrors extends Record<string, unknown> = Record<never, never>,
  >(
    name: TName,
    def: KitActorDef<TDef, TState, TErrors, ES, SD, TEnvSchema>,
  ): ActorContract<TName, KitContractDef<TDef, ES, TEnvSchema>>;
}

/**
 * What the kit fixes in a definition: an actor with declared states names its `initial` among them and
 * defines every one; an actor without has neither. `events` and `env` come from the kit.
 */
export type KitDefCheck<SD> = { events?: never; env?: never; determinism?: DeterminismMode } & ([keyof SD] extends [
  never,
]
  ? { initial?: never; states?: never }
  : { initial: keyof SD & string; states: { [P in keyof SD]: unknown } });

/** A definition for `kit.actor`: defineActor's checks, with the kit's events, env and states. */
export type KitActorDef<TDef, TState, TErrors, ES extends EventSchemas, SD, TEnvSchema> = TDef &
  KitDefCheck<SD> &
  VersionsCheck<TDef> &
  PublishCheck<KitContractDef<TDef, ES, TEnvSchema>> &
  TypedServices<TState, TErrors, SetupEnv<TEnvSchema>, EventPayloads<ES>>;

/** The contract's definition: the actor's own, plus the kit's events and env. */
export type KitContractDef<TDef, ES, TEnvSchema> = TDef & { readonly events: ES; readonly env: TEnvSchema };

/** What `kit.service()` takes: a service definition whose callbacks are typed by the kit. */
export interface KitServiceDef<S, TResult, TDeclared, TEnv, E = Record<never, never>> {
  readonly errors?: z.ZodType<TDeclared>;
  readonly result?: z.ZodType<TResult>;
  readonly maxResultBytes?: number;
  readonly delivery?: "at-least-once" | "at-most-once";
  fn(input: unknown, env: TEnv, effect: EffectInfo): Promise<unknown>;
  readonly retry?: ServiceRetry<ServiceErrorOf<TDeclared>>;
  readonly timeoutMs?: number;
  onDone?(state: S, result: TResult, input: unknown, ctx: ServiceCallbackContext<TEnv, E>): S;
  onError?(state: S, error: ServiceErrorOf<TDeclared>, input: unknown, ctx: ServiceCallbackContext<TEnv, E>): S;
}

/** The persisted state of an actor declared with `kit`, for views and roles: `PhasedStateOf<typeof kit, Shared>`. */
export type PhasedStateOf<K, S> = K extends { states: infer SD extends StateDecls | undefined }
  ? PhasedState<Exclude<SD, undefined>, S>
  : never;

/** Bind a handler to a typed emit over the runtime's (checked) one. */
function typed<S, P, Ctx extends { readonly emit: (name: string, payload: unknown) => void }, E>(
  handler: Handler<S, P, Omit<Ctx, "emit"> & { readonly emit: TypedEmit<E> }>,
): Handler<S, P, Ctx> {
  return (state, payload, ctx) => handler(state, payload, { ...ctx, emit: (name, value) => ctx.emit(name, value) });
}

/**
 * Declare what an actor has up front (events, states, env) and get the typed helpers and `kit.actor`
 * (ADR-018 A). Everything is optional: `setup({})` is the kit of an actor with none of them.
 */
export function setup<
  const ES extends EventSchemas,
  const SD extends StateDecls = Record<never, never>,
  TEnvSchema extends z.ZodType | undefined = undefined,
>(declarations: { events: ES; states?: SD; env?: TEnvSchema }): Setup<ES, SD, TEnvSchema>;
export function setup<
  const SD extends StateDecls = Record<never, never>,
  TEnvSchema extends z.ZodType | undefined = undefined,
>(declarations: { events?: undefined; states?: SD; env?: TEnvSchema }): Setup<Record<never, never>, SD, TEnvSchema>;
export function setup<const SD extends StateDecls, TEnvSchema extends z.ZodType | undefined>(declarations: {
  events?: EventSchemas | undefined;
  states?: SD;
  env?: TEnvSchema;
}): Setup<EventSchemas, SD, TEnvSchema | undefined> {
  return kitOf(declarations.events ?? {}, declarations.states, declarations.env);
}

function kitOf<ES extends EventSchemas, SD extends StateDecls, TEnvSchema>(
  events: ES,
  states: SD | undefined,
  env: TEnvSchema,
): Setup<ES, SD, TEnvSchema> {
  return {
    events,
    states,
    env,
    message(schema, handler) {
      if (typeof handler === "function") return { schema, handler: typed(handler) };
      return { schema, handler: typed(handler.handler), guard: handler.guard };
    },
    timer(schema, handler) {
      return { schema, handler: typed(handler) };
    },
    service: (def) => def,
    link: (contract, handlers) => link(contract, handlers),
    in(target) {
      const decl = declAt(states, pathOf(target));
      const declared = {
        ...(decl?.local === undefined ? {} : { local: decl.local }),
        ...(decl?.input === undefined ? {} : { input: decl.input }),
      };
      return {
        message: (schema, handler) =>
          typeof handler === "function"
            ? { schema, handler }
            : { schema, handler: handler.handler, guard: handler.guard },
        timer: (schema, handler) => ({ schema, handler }),
        state: (def) => ({ ...def, ...declared }),
      };
    },
    actor(name, def) {
      return { name, def: { ...def, events, env } };
    },
  };
}

/** For handlers outside setup(): `stay` and `goto` values (the context's are the typed ones). */
export { gotoPhase as goto, stayInPhase as stay };

/** The declaration at a path, if the kit declares it at runtime (types may declare more). */
function declAt(states: StateDecls | undefined, path: readonly string[]): StateDecl | undefined {
  let decl: StateDecl | undefined;
  let children = states;
  for (const name of path) {
    decl = children?.[name];
    children = decl?.states;
  }
  return decl;
}
