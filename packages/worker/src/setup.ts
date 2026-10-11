/**
 * setup() — typed helpers for what an actor declares up front (ADR-017).
 *
 *   const quiz = setup({
 *     events: { RoundStarted: z.object({ n: z.number() }) },
 *     states: { lobby: {}, round: { local: RoundLocal, input: z.object({ n: z.number() }) }, reveal: {} },
 *   });
 *   const round = quiz.in("round");
 *   defineActor("quiz", {
 *     events: quiz.events,
 *     initial: "lobby",
 *     states: {
 *       lobby: quiz.in("lobby").state({ messages: { START: quiz.in("lobby").message(z.object({}), (s: S, _p, ctx) => ctx.goto("round", s, { n: 1 })) } }),
 *       round: round.state({ enter: (s: S, { n }, ctx) => ({ n, answers: {} }), messages: { ... }, timers: { ... } }),
 *       reveal: quiz.in("reveal").state({}),
 *     },
 *   });
 *
 * A `message()` handler defined inline cannot see the actor's `events` or `states` (TypeScript does
 * not infer a nested generic call from its siblings), so the typed `emit`, `local`, `stay` and
 * `goto` come from helpers bound to the declarations, like XState's `setup()`. Everything is also
 * checked at runtime: emitted payloads and locals are parsed by their schemas.
 */

import type { GuardContext, MessageContext, MessageDef, TimerContext, TimerDef } from "@actor-kit/core";
import type { z } from "zod";
import { message } from "./message";
import { goto as gotoPhase, PhaseTransition, stay as stayInPhase } from "./runtime/phases";
import { timer } from "./timer";

export { PhaseTransition };

export type EventSchemas = Record<string, z.ZodType>;

/** Payload type of each declared event. */
export type EventPayloads<T extends EventSchemas> = { [K in keyof T]: z.output<T[K]> };

/** emit() typed by an actor's declared events. */
export type TypedEmit<E> = <K extends keyof E & string>(name: K, payload: E[K]) => void;

/** A declared state: its local's schema and its enter input's schema, both optional. */
export interface StateDecl {
  readonly local?: z.ZodType;
  readonly input?: z.ZodType;
}

export type StateDecls = Record<string, StateDecl>;

/** The local of a state (null when it declares none). */
export type LocalOf<D> = D extends { local: z.ZodType<infer L> } ? L : null;
/** goto's input argument: required when the state declares `input`, absent otherwise. */
export type InputArgs<D> = D extends { input: z.ZodType<infer I> } ? [input: I] : [];

export type Goto<SD extends StateDecls, S> = <K extends keyof SD & string>(
  phase: K,
  shared: S,
  ...input: InputArgs<SD[K]>
) => PhaseTransition<S>;

/** What a handler returns in an actor with states: the next shared state (stay), or stay/goto. */
export type PhaseResult<S> = S | PhaseTransition<S>;

/** The state an actor with states persists, as views, roles and Studio see it. */
export type PhasedState<SD extends StateDecls, S> = {
  [P in keyof SD & string]: { shared: S; phase: P; local: LocalOf<SD[P]>; stateTimers: string[] };
}[keyof SD & string];

type Base<Ctx> = Omit<Ctx, "emit">;

export type EmittingMessageContext<TEnv, E> = Base<MessageContext<TEnv>> & { readonly emit: TypedEmit<E> };
export type EmittingTimerContext<TEnv, E> = Base<TimerContext<TEnv>> & { readonly emit: TypedEmit<E> };

/** The phase part of a handler's context, in phase P. */
export interface PhaseContext<SD extends StateDecls, P extends keyof SD & string, S> {
  readonly phase: P;
  readonly local: LocalOf<SD[P]>;
  stay(shared: S, ...local: LocalOf<SD[P]> extends null ? [] : [local?: LocalOf<SD[P]>]): PhaseTransition<S>;
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

/** What `enter` gets: the effect verbs and the phase being entered (no local yet: enter builds it). */
export type EnterContext<TEnv, E, P extends string> = Omit<Base<TimerContext<TEnv>>, "key" | "lateBy"> & {
  readonly emit: TypedEmit<E>;
  readonly phase: P;
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
  readonly messages?: Record<string, StatePart<S>>;
  readonly timers?: Record<string, StatePart<S>>;
}

type PhaseCtx<TEnv, E, SD extends StateDecls, P extends keyof SD & string, S> = EmittingMessageContext<TEnv, E> &
  PhaseContext<SD, P, S>;
type PhaseTimerCtx<TEnv, E, SD extends StateDecls, P extends keyof SD & string, S> = EmittingTimerContext<TEnv, E> &
  PhaseContext<SD, P, S>;
type PhaseGuardCtx<TEnv, SD extends StateDecls, P extends keyof SD & string> = GuardContext<TEnv> & {
  readonly phase: P;
  readonly local: LocalOf<SD[P]>;
};

export interface PhaseHelpers<SD extends StateDecls, E, P extends keyof SD & string, TEnvDefault = unknown> {
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
  /** The state's messages keep their names and payloads, so the typed client `send` lists them (ADR-018 B). */
  state<S, TEnv = TEnvDefault, const M extends Record<string, StatePart<S>> = Record<never, never>>(def: {
    enter?: (
      shared: S,
      input: InputArgs<SD[P]> extends [infer I] ? I : undefined,
      ctx: EnterContext<TEnv, E, P>,
    ) => LocalOf<SD[P]>;
    messages?: M;
    timers?: Record<string, StatePart<S>>;
  }): Omit<StateDef<S>, "messages"> & { readonly messages?: M };
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
  /** Helpers for one declared state: its messages, timers and `enter` see its typed local. */
  in<P extends keyof SD & string>(phase: P): PhaseHelpers<SD, EventPayloads<ES>, P, SetupEnv<TEnvSchema>>;
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

export function setup<const ES extends EventSchemas, const SD extends StateDecls = Record<never, never>>(declarations: {
  events: ES;
  states?: SD;
}): Setup<ES, SD>;
/** With `env` (ADR-016 §4): every helper's ctx.env is the schema's output; pass `env: kit.env` to the actor. */
export function setup<
  const ES extends EventSchemas,
  const SD extends StateDecls = Record<never, never>,
  TEnvSchema extends z.ZodType = z.ZodType,
>(declarations: { events: ES; states?: SD; env: TEnvSchema }): Setup<ES, SD, TEnvSchema>;
export function setup<
  const ES extends EventSchemas,
  const SD extends StateDecls,
  TEnvSchema extends z.ZodType | undefined,
>(declarations: { events: ES; states?: SD; env?: TEnvSchema }): Setup<ES, SD, TEnvSchema | undefined> {
  return {
    events: declarations.events,
    states: declarations.states,
    env: declarations.env,
    message(schema, handler) {
      if (typeof handler === "function") return message(schema, typed(handler));
      return message(schema, { guard: handler.guard, handler: typed(handler.handler) });
    },
    timer(schema, handler) {
      return timer(schema, typed(handler));
    },
    in(phase) {
      const local = declarations.states?.[phase]?.local;
      return {
        message: (schema, handler) =>
          typeof handler === "function"
            ? { schema, handler }
            : { schema, handler: handler.handler, guard: handler.guard },
        timer: (schema, handler) => ({ schema, handler }),
        state: (def) => (local === undefined ? def : { ...def, local }),
      };
    },
  };
}

/** For handlers outside setup(): `stay` and `goto` values (the context's are the typed ones). */
export { gotoPhase as goto, stayInPhase as stay };
