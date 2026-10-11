/**
 * The step core (ADR-015 D4, Q4): one transition as a pure function.
 *
 *   step(def, state, cause, facts, env) → { state, effects, event }
 *
 * `cause` is what happened (a message already admitted, a lifecycle event, a service result, a
 * link update, a migration). `facts` is everything the handlers read from the outside world:
 * now/id/random, and the targets of an `unlink(name)` with no id. Live, facts read the real
 * sources and record what they returned; on replay they hand the recorded values back. The
 * result is the next state, the effects the transition declared (executions and forwards with
 * their effect index, links, unlinks) and the journal event to append.
 *
 * The Durable Object (`actor.ts`), journal replay (`applyJournalEvent`) and `simulate()` all
 * run transitions through here, so they cannot drift apart. Nothing here touches storage.
 */

import type {
  DeliveryInfo,
  DeterministicContext,
  ExecuteOptions,
  GuardContext,
  ScheduleOptions,
} from "@actor-kit/core";
import { ActorKitError } from "@actor-kit/core";
import { parseDuration } from "./duration";
import { createReplayFacts, type Facts, type JournalDraft, type LiveFacts } from "./journal";
import { createOutbox, type UnlinkCall } from "./outbox";
import { assertSync, initialPhase, type PhaseContext, type PhaseRun, runAtLevel } from "./phase-run";
import { dotted, innermost, mergeLocals, phasedState, type StepStateDef, statesDeclaring } from "./phases";
import type { ParseIssue } from "./refusal";
import { resolveRole } from "./roles";
import type { ErrorsParser } from "./service-error";
import type { Trace } from "./trace";

// --- Definition (runtime-shaped: unknown-typed, bivariant methods) ---

export interface StepMessageSlot {
  readonly schema: {
    safeParse(
      data: unknown,
    ):
      | { success: true; data: unknown }
      | { success: false; error: { message: string; issues?: readonly ParseIssue[] | undefined } };
  };
  handler(state: unknown, payload: unknown, ctx: unknown): unknown;
  guard?(state: unknown, payload: unknown, ctx: GuardContext): boolean;
}

export interface StepDef {
  init?(input: unknown, ctx: unknown): unknown;
  roles?: Record<string, (state: unknown, caller: string, claims: { callerType: "user" | "service" }) => boolean>;
  /** Role-nested, as the runtime stores them. */
  messages?: Record<string, Record<string, { handler(state: unknown, payload: unknown, ctx: unknown): unknown }>>;
  lifecycle?: {
    connect?(state: unknown, event: LifecycleCallEvent, ctx: unknown): unknown;
    disconnect?(state: unknown, event: LifecycleCallEvent, ctx: unknown): unknown;
  };
  services?: Record<
    string,
    {
      /** Declared failures (ADR-016 §2); the step core passes errors through, simulate() parses rejections. */
      readonly errors?: ErrorsParser | undefined;
      onDone?(state: unknown, result: unknown, input: unknown, ctx: ServiceCallbackCtx): unknown;
      /** `error`: the typed service error (ADR-016 §2): a declared error, a Timeout, a Defect or Evicted. */
      onError?(state: unknown, error: unknown, input: unknown, ctx: ServiceCallbackCtx): unknown;
      /** A result that arrived after the state that owned the call was left (ADR-019 B). */
      onStale?(state: unknown, result: unknown, input: unknown, ctx: ServiceCallbackCtx): unknown;
    }
  >;
  links?: Record<
    string,
    {
      onUpdate(state: unknown, view: unknown, id: string | undefined, ctx: LinkCallbackCtx): unknown;
      onError?:
        | ((
            state: unknown,
            error: { message: string; code: string },
            id: string | undefined,
            ctx: LinkCallbackCtx,
          ) => unknown)
        | undefined;
      onUnlink?: ((state: unknown, id: string | undefined, ctx: LinkCallbackCtx) => unknown) | undefined;
    }
  >;
  timers?: Record<
    string,
    { readonly schema: SafeParser; handler(state: unknown, payload: unknown, ctx: unknown): unknown }
  >;
  /** Domain events (ADR-017 §2): payload schemas by name. */
  events?: Record<string, SafeParser>;
  /** States with typed locals (ADR-017 §1): the phase an actor starts in, and each phase. */
  initial?: string;
  states?: Record<string, StepStateDef>;
  migrate?(persisted: unknown, fromVersion: number): unknown;
  serialize?(state: unknown): unknown;
  restore?(serialized: unknown): unknown;
  /** The current code version (ADR-015 D5; compiled from `versions`). */
  version?: number;
  /** Every version in the chain: journal events written by any other version have no path. */
  knownVersions?: readonly number[];
  /** Upcast a message payload journaled at `fromVersion` to the current version. */
  upcast?(message: string, payload: unknown, fromVersion: number): unknown;
  /** Rename and upcast a domain event emitted at `fromVersion` to the current version (ADR-018 F). */
  upcastEmitted?(
    event: { readonly name: string; readonly payload: unknown },
    fromVersion: number,
  ): { readonly name: string; readonly payload: unknown };
}

interface SafeParser {
  safeParse(data: unknown): { success: true; data: unknown } | { success: false; error: { message: string } };
}

interface LifecycleCallEvent {
  caller: string;
  callerType: "user" | "service";
  callerConnections?: number;
}

// --- Causes ---

/** A service error as the step core carries it: the parsed value, opaque here (ADR-016 §2). */
export type ServiceErrorValue = Readonly<Record<string, unknown>>;

type Caller = { readonly caller: string; readonly callerType: "user" | "service" };

/** A cause that continues a flow carries its trace (ADR-017 §4); it is journaled with the event. */
type Traced = { readonly trace?: Trace | undefined };

export type StepCause = Traced &
  (
    | ({
        readonly type: "message";
        readonly name: string;
        readonly payload: unknown;
        readonly role: string;
        /** The forward that delivered the message (ADR-016 §1): the handler's ctx.delivery, journaled as a fact. */
        readonly delivery?: DeliveryInfo | undefined;
      } & Caller)
    | ({
        readonly type: "lifecycle.connect" | "lifecycle.disconnect";
        /** Live only: how many sockets the caller holds after the event. Not journaled. */
        readonly callerConnections?: number;
        /** The caller's role for connect; ignored for disconnect (resolved on the next state). */
        readonly role: string | null;
      } & Caller)
    | {
        readonly type: "service.onDone";
        readonly service: string;
        readonly input: unknown;
        readonly result: unknown;
        /** The execution's effect id (journaled, so restore can match results to effects). */
        readonly effectId?: string | undefined;
        /** Audit facts the try recorded with effect.record() (ADR-018 G): journaled, never replayed. */
        readonly audit?: Readonly<Record<string, unknown>> | undefined;
      }
    | {
        /** A result that arrived after the state owning its call was left (ADR-019 B): onStale, or nothing. */
        readonly type: "service.stale";
        readonly service: string;
        readonly input: unknown;
        readonly result: unknown;
        readonly effectId?: string | undefined;
      }
    | {
        readonly type: "service.onError";
        readonly service: string;
        readonly input: unknown;
        readonly effectId?: string | undefined;
        /** The parsed service error (ADR-016 §2), journaled as it is so replay delivers the same value. */
        readonly error: ServiceErrorValue;
        readonly audit?: Readonly<Record<string, unknown>> | undefined;
      }
    | { readonly type: "link.onUpdate"; readonly link: string; readonly sourceId: string; readonly view: unknown }
    | {
        readonly type: "link.onError";
        readonly link: string;
        readonly targetId: string;
        readonly error: { readonly message: string; readonly code: string };
      }
    | {
        readonly type: "migrate";
        readonly fromVersion: number;
        readonly toVersion: number;
        readonly persisted: unknown;
      }
    | {
        readonly type: "timer";
        readonly name: string;
        /** The timer's effect id (`seq:index` of the transition that scheduled it). */
        readonly id: string;
        readonly key: string;
        readonly payload: unknown;
        readonly fireAt: number;
        readonly lateBy: number;
      }
  );

// --- Facts ---

/** What has happened to one link name earlier in the transition, for `unlink(name)` with no id. */
export interface PendingLinks {
  /** Ids this transition linked under the name (written before any unlink runs). */
  readonly linked: readonly string[];
  /** Unlink calls (any name) that ran before this one. */
  readonly earlier: readonly UnlinkCall[];
}

export interface StepFacts {
  readonly ctx: DeterministicContext;
  /** Targets `unlink(name)` (no id) removes, in the order onUnlink runs for them. */
  unlinkTargets(name: string, pending: PendingLinks): string[];
  /** The facts read so far, for the journal event. */
  recorded(): Facts;
  /**
   * Runs every handler call (ADR-016 §5). The test harness passes withDeterminismGuard; the Workers
   * runtime passes nothing, so handlers run as they are.
   */
  readonly guard?: (<T>(handler: () => T) => T) | undefined;
  /** The seq the transition will be committed under (0 outside a runtime): ctx.execute returns `seq:index`. */
  readonly seq?: number | undefined;
}

/** Call a handler through the facts' guard, if any. */
function guarded<T>(facts: StepFacts, handler: () => T): T {
  return facts.guard === undefined ? handler() : facts.guard(handler);
}

/**
 * Live targets of `unlink(name)`: the stored links (in insertion order) plus the ones this
 * transition linked, minus those an earlier unlink removed. An earlier `unlink(name)` removed all.
 */
export function liveUnlinkTargets(read: (name: string) => string[], name: string, pending: PendingLinks): string[] {
  const earlier = pending.earlier.filter((call) => call.name === name);
  if (earlier.some((call) => call.id === undefined)) return [];
  const removed = new Set(earlier.map((call) => call.id));
  const targets = new Set([...read(name), ...pending.linked]);
  return [...targets].filter((id) => !removed.has(id));
}

/** Step facts for a live transition: real sources, recorded; unlink targets read from storage. */
export function liveStepFacts(live: LiveFacts, read: (name: string) => string[]): StepFacts {
  return {
    ctx: live.ctx,
    unlinkTargets(name, pending) {
      const targets = liveUnlinkTargets(read, name, pending);
      live.recordUnlinked(name, targets);
      return targets;
    },
    recorded: () => live.facts(),
  };
}

/** Step facts for replay: the event's recorded facts, handed back in order. */
export function replayStepFacts(
  facts: Facts,
  guard?: <T>(handler: () => T) => T,
  seq?: number,
): StepFacts & { takeLinkView(name: string, id: string): unknown } {
  const replay = createReplayFacts(facts);
  return {
    guard,
    seq,
    ctx: replay.ctx,
    unlinkTargets: (name) => replay.takeUnlinked(name),
    recorded: () => facts,
    takeLinkView: (name, id) => replay.takeLinkView(name, id),
  };
}

// --- Result ---

export type StepEffects = ReturnType<typeof createOutbox>;

export interface StepResult {
  readonly state: unknown;
  /** For messages: the handler's state before onUnlink ran (what observe.onTransition sees). */
  readonly handlerState: unknown;
  readonly effects: StepEffects;
  readonly event: JournalDraft;
  /** Journal this transition even when it changes nothing (a late result, ADR-019 B). */
  readonly alwaysJournal?: true;
}

// --- Message admission (live only: replay never asks again) ---

export type Admission<M = unknown> =
  | { ok: true; payload: unknown; message: M }
  | { ok: false; error: "message_not_found" | "guard_failed" }
  | { ok: false; error: "validation_failed"; detail: string; issues?: readonly ParseIssue[] | undefined };

/** Admission for an actor that may have states: also `wrong_state` (the current phase, the states that accept it). */
export type StepAdmission<M = unknown> =
  | Admission<M>
  | { ok: false; error: "wrong_state"; phase: string; acceptedIn: readonly string[] };

/**
 * Admit a message for an actor, with or without `states` (ADR-017 §1). With states, a message is
 * found in the current phase's `messages`, then the top-level ones; a message only other phases
 * declare is rejected with `wrong_state` before its guard runs. Guards see the shared state and
 * the phase and local in their context.
 */
export function admitStepMessage(
  def: {
    readonly messages?: Record<string, Record<string, StepMessageSlot>>;
    readonly states?: Record<string, StepStateDef>;
  },
  role: string,
  state: unknown,
  event: { type: string; [key: string]: unknown },
  ctx: Omit<GuardContext, "role">,
): StepAdmission<StepMessageSlot> {
  const states = def.states;
  const roleMessages: Record<string, Record<string, StepMessageSlot>> = def.messages ?? {};
  if (states === undefined) return admitMessage(roleMessages, role, state, event, ctx);
  const current = phasedState(state);
  const inPath = innermost(states, current.phase, (d) => d.messages?.[event.type]);
  const message = inPath?.found ?? roleMessages[role]?.[event.type];
  if (message === undefined) {
    const acceptedIn = statesDeclaring(states, event.type);
    if (acceptedIn.length === 0) return { ok: false, error: "message_not_found" };
    return { ok: false, error: "wrong_state", phase: dotted(current.phase), acceptedIn };
  }
  const level = inPath?.depth ?? current.phase.length;
  const phaseCtx = { ...ctx, phase: current.phase, local: mergeLocals(current.locals.slice(0, level)) };
  return admitMessage({ [role]: { [event.type]: message } }, role, current.shared, event, phaseCtx);
}

/** Find the message for the role, parse its payload (the event minus `type`) and run its guard. */
export function admitMessage<M extends Pick<StepMessageSlot, "schema" | "guard">>(
  roleMessages: Record<string, Record<string, M>>,
  role: string,
  state: unknown,
  event: { type: string; [key: string]: unknown },
  ctx: Omit<GuardContext, "role">,
): Admission<M> {
  const message = roleMessages[role]?.[event.type];
  if (message === undefined) return { ok: false, error: "message_not_found" };
  const { type: _type, ...payload } = event;
  const parsed = message.schema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", detail: parsed.error.message, issues: parsed.error.issues };
  }
  if (message.guard !== undefined && !message.guard(state, parsed.data, { ...ctx, role })) {
    return { ok: false, error: "guard_failed" };
  }
  return { ok: true, payload: parsed.data, message };
}

// --- step ---

function draft(
  cause: { causeType: JournalDraft["causeType"]; name: string | null; payload: unknown },
  who: { caller: string | null; callerType: "user" | "service" | null; role: string | null },
  facts: StepFacts,
): JournalDraft {
  return { ...cause, ...who, facts: facts.recorded() };
}

const NOBODY = { caller: null, callerType: null, role: null } as const;

/** Run onUnlink for each unlink call, in order: by id, or for every target of `unlink(name)`. */
function applyUnlinks(def: StepDef, state: unknown, effects: StepEffects, facts: StepFacts): unknown {
  const links = effects.getLinks();
  const unlinks = effects.getUnlinks();
  let next = state;
  unlinks.forEach((call, position) => {
    const onUnlink = def.links?.[call.name]?.onUnlink;
    if (onUnlink === undefined) return;
    const ids =
      call.id !== undefined
        ? [call.id]
        : facts.unlinkTargets(call.name, {
            linked: links.filter((l) => l.name === call.name).map((l) => l.id),
            earlier: unlinks.slice(0, position),
          });
    const ctx = { ...facts.ctx, emit: emitVerb(def, effects) };
    for (const id of ids) next = guarded(facts, () => onUnlink(next, id, ctx));
  });
  return next;
}

/** When a timer fires: `at`, or ctx.now() + `in`. Exactly one of the two. */
function fireAtOf(options: ScheduleOptions, det: DeterministicContext): number {
  if ((options.in === undefined) === (options.at === undefined)) {
    throw new ActorKitError("invalid_schedule", "ctx.schedule needs exactly one of `in` and `at`");
  }
  if (options.at !== undefined) {
    if (!Number.isFinite(options.at)) {
      throw new ActorKitError(
        "invalid_schedule",
        `ctx.schedule: invalid \`at\` ${options.at}: pass a finite time in ms`,
      );
    }
    return options.at;
  }
  return det.now() + parseDuration(options.in);
}

/**
 * ctx.execute where no state can own the call (an actor without states, lifecycle, top-level helpers'
 * base context): a `scope: "state"` call is refused (ADR-019 B).
 */
function plainExecute(effects: StepEffects): (service: string, input: unknown, options?: ExecuteOptions) => string {
  return (service, input, options) => {
    if (options?.scope === "state") {
      throw new ActorKitError(
        "invalid_scope",
        `ctx.execute("${service}", ..., { scope: "state" }) needs a state to belong to: call it from a state's message, timer or enter, in an actor with states.`,
      );
    }
    return effects.execute(service, input);
  };
}

/** ctx.emit for a transition: the event must be declared and its payload must parse (ADR-017 §2). */
function emitVerb(def: StepDef, effects: StepEffects): (name: string, payload: unknown) => void {
  return (name, payload) => {
    const schema = def.events?.[name];
    if (schema === undefined) {
      throw new ActorKitError(
        "undeclared_event",
        `Event "${name}" is not declared on this actor. Declare it in setup({ events }) and define the actor with kit.actor().`,
      );
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ActorKitError("invalid_event_payload", `Event "${name}": invalid payload: ${parsed.error.message}`);
    }
    effects.emit(name, parsed.data);
  };
}

/**
 * A timer by name, with the level that declares it: innermost first along `path` (actors with states),
 * then the top-level ones (depth null).
 */
export function findTimerAt(def: StepDef, path: readonly string[] | null, name: string) {
  const inPath = path === null ? undefined : innermost(def.states ?? {}, path, (d) => d.timers?.[name]);
  if (inPath !== undefined) return { timer: inPath.found, depth: inPath.depth };
  const top = def.timers?.[name];
  return top === undefined ? undefined : { timer: top, depth: null };
}

/** A timer by name: along the active path (actors with states), then the top-level ones. */
export function findTimer(def: StepDef, path: readonly string[] | null, name: string) {
  return findTimerAt(def, path, name)?.timer;
}

/**
 * ctx.schedule / ctx.cancel for a transition: the timer must be declared and its payload must parse.
 * `path`: the level a handler runs at (actors with states), whose timers it can schedule.
 */
function timerVerbs(
  def: StepDef,
  effects: StepEffects,
  det: DeterministicContext,
  path: readonly string[] | null = null,
) {
  return {
    schedule: (name: string, options: ScheduleOptions): void => {
      const timer = findTimer(def, path, name);
      if (timer === undefined) {
        throw new ActorKitError(
          "undeclared_timer",
          `Timer "${name}" is not declared on this actor. Declare it in timers: { ${name}: timer(schema, handler) }.`,
        );
      }
      const parsed = timer.schema.safeParse(options.payload);
      if (!parsed.success) {
        throw new ActorKitError("invalid_timer_payload", `Timer "${name}": invalid payload: ${parsed.error.message}`);
      }
      effects.schedule(
        { name, key: options.key ?? null, payload: parsed.data ?? null, fireAt: fireAtOf(options, det) },
        { timer: name, options },
      );
    },
    cancel: (key: string): void => effects.cancel(key),
  };
}

// --- States (ADR-017 §1, ADR-019 A) ---

/** One transition's view of the state tree (phase-run.ts moves through it). */
function phaseRun(
  def: StepDef,
  states: Record<string, StepStateDef>,
  effects: StepEffects,
  facts: StepFacts,
  env: unknown,
): PhaseRun {
  return {
    states,
    base: {
      ...facts.ctx,
      env,
      execute: plainExecute(effects),
      forward: effects.forward,
      emit: emitVerb(def, effects),
    },
    verbs: (path) => timerVerbs(def, effects, facts.ctx, path),
    execute: effects.execute,
    leave: (key) => effects.cancel(key, true),
  };
}

/**
 * Run a handler: as is for an actor without states; for one with states, on the shared state with
 * the phase context at the level that declares it (`depth`; null for a top-level one), its result
 * settling the phase (stay, goto, or plain shared = stay).
 */
function runHandler(
  run: { readonly def: StepDef; readonly effects: StepEffects; readonly facts: StepFacts; readonly env: unknown },
  state: unknown,
  depth: number | null,
  call: (state: unknown, phase: PhaseContext | null) => unknown,
  firedKey: string | null = null,
): unknown {
  const states = run.def.states;
  if (states === undefined) return call(state, null);
  return runAtLevel(phaseRun(run.def, states, run.effects, run.facts, run.env), state, depth, call, firedKey);
}

/** For handlers that only see the shared state (lifecycle, services, links): the result is the new shared state. */
function onShared(def: StepDef, state: unknown, fn: (shared: unknown) => unknown): unknown {
  if (def.states === undefined) return fn(state);
  const current = phasedState(state);
  const next = fn(current.shared);
  return next === current.shared ? state : { ...current, shared: next };
}

/** The active path of an actor with states (null without states). */
export function phaseOf(def: StepDef, state: unknown): string[] | null {
  return def.states === undefined ? null : phasedState(state).phase;
}

/**
 * The message's handler and the level that declares it: innermost first along the active path, then
 * the role's top-level one (depth null).
 */
export function findMessage(def: StepDef, state: unknown, role: string, name: string) {
  const path = phaseOf(def, state);
  const inPath = path === null ? undefined : innermost(def.states ?? {}, path, (d) => d.messages?.[name]);
  if (inPath !== undefined) return { slot: inPath.found, depth: inPath.depth };
  const top = def.messages?.[role]?.[name];
  return top === undefined ? undefined : { slot: top, depth: null };
}

export function messageSlot(def: StepDef, state: unknown, role: string, name: string) {
  return findMessage(def, state, role, name)?.slot;
}

function stepMessage(
  def: StepDef,
  state: unknown,
  cause: Extract<StepCause, { type: "message" }>,
  facts: StepFacts,
  env: unknown,
): StepResult {
  const found = findMessage(def, state, cause.role, cause.name);
  if (found === undefined) {
    throw new ActorKitError(
      "unknown_message",
      `Message "${cause.name}" is not defined for role "${cause.role}". Add it to the role's messages (or a versions step for a removed message).`,
    );
  }
  const effects = createOutbox(facts.seq);
  const base = {
    ...facts.ctx,
    caller: cause.caller,
    callerType: cause.callerType,
    role: cause.role,
    env,
    ...(cause.delivery === undefined ? {} : { delivery: cause.delivery }),
    execute: plainExecute(effects),
    link: effects.link,
    unlink: effects.unlink,
    forward: effects.forward,
    emit: emitVerb(def, effects),
    ...timerVerbs(def, effects, facts.ctx),
  };
  const handlerState = guarded(facts, () =>
    runHandler({ def, effects, facts, env }, state, found.depth, (current, phase) => {
      const result = found.slot.handler(current, cause.payload, { ...base, ...phase });
      assertSync(
        result,
        `Message handler for "${cause.name}" returned a Promise. Handlers must be synchronous — use execute() for async side effects.`,
      );
      return result;
    }),
  );
  const next = applyUnlinks(def, handlerState, effects, facts);
  const event = draft(
    { causeType: "message", name: cause.name, payload: cause.payload },
    { caller: cause.caller, callerType: cause.callerType, role: cause.role },
    facts,
  );
  const delivery = cause.delivery;
  return {
    state: next,
    handlerState,
    effects,
    event: delivery === undefined ? event : { ...event, facts: { ...event.facts, delivery } },
  };
}

function lifecyclePayload(cause: { readonly callerConnections?: number }): { callerConnections?: number } {
  return cause.callerConnections === undefined ? {} : { callerConnections: cause.callerConnections };
}

function stepLifecycle(
  def: StepDef,
  state: unknown,
  cause: Extract<StepCause, { type: "lifecycle.connect" | "lifecycle.disconnect" }>,
  facts: StepFacts,
  env: unknown,
): StepResult {
  const which = cause.type === "lifecycle.connect" ? "connect" : "disconnect";
  const handler = def.lifecycle?.[which];
  const effects = createOutbox(facts.seq);
  const who = { caller: cause.caller, callerType: cause.callerType };
  const event = cause.callerConnections === undefined ? who : { ...who, callerConnections: cause.callerConnections };
  const next =
    handler === undefined
      ? state
      : guarded(facts, () =>
          onShared(def, state, (shared) => {
            const result = handler(shared, event, {
              ...facts.ctx,
              ...who,
              env,
              execute: plainExecute(effects),
              forward: effects.forward,
              emit: emitVerb(def, effects),
              ...timerVerbs(def, effects, facts.ctx),
            });
            assertSync(result, `lifecycle.${which} returned a Promise. Handlers must be synchronous.`);
            return result;
          }),
        );
  const role =
    which === "connect"
      ? cause.role
      : resolveRole(def.roles ?? {}, next, cause.caller, { callerType: cause.callerType });
  return {
    state: next,
    handlerState: next,
    effects,
    // callerConnections is journaled (it is what the handler read), so replay hands it back.
    event: draft({ causeType: cause.type, name: null, payload: lifecyclePayload(cause) }, { ...who, role }, facts),
  };
}

type CallbackCause = Exclude<StepCause, { type: "message" | "lifecycle.connect" | "lifecycle.disconnect" | "timer" }>;
type CallbackOutcome = { next: unknown; name: string | null; payload: unknown };
type On<K extends CallbackCause["type"]> = Extract<CallbackCause, { type: K }>;

// Transitions without a caller: service results, link callbacks, migration. A missing handler is a no-op.

/** A service result's journal payload: the effect id and the try's audit facts, when there are any. */
function resultPayload<P extends object>(
  payload: P,
  cause: { readonly effectId?: string | undefined; readonly audit?: Readonly<Record<string, unknown>> | undefined },
): P | (P & { effectId: string }) | (P & { effectId?: string; audit: Readonly<Record<string, unknown>> }) {
  const withId = cause.effectId === undefined ? payload : { ...payload, effectId: cause.effectId };
  return cause.audit === undefined ? withId : { ...withId, audit: cause.audit };
}

/**
 * What onDone / onError get as ctx: now/id/random, the actor's env (ADR-016 §4), the call's effect id
 * (ADR-018 G) and emit (ADR-018 F: callbacks emit domain events like handlers).
 */
type ServiceCallbackCtx = DeterministicContext & {
  readonly env: unknown;
  readonly effectId: string;
  readonly emit: (name: string, payload: unknown) => void;
};

/** What link callbacks get as ctx: now/id/random and emit (ADR-018 F). */
type LinkCallbackCtx = DeterministicContext & { readonly emit: (name: string, payload: unknown) => void };

/** onDone / onError's ctx; an entry journaled before effect ids has an empty one. */
function callbackCtx(
  det: LinkCallbackCtx,
  env: unknown,
  cause: { readonly effectId?: string | undefined },
): ServiceCallbackCtx {
  return { ...det, env, effectId: cause.effectId ?? "" };
}

/** What a service callback needs to run in a state tree. */
interface CallbackRun {
  readonly def: StepDef;
  readonly effects: StepEffects;
  readonly facts: StepFacts;
  readonly env: unknown;
}

type ServiceCallback = (state: unknown, value: unknown, input: unknown, ctx: ServiceCallbackCtx) => unknown;

/**
 * Run a service callback (ADR-019 B). Without states, on the state as it is. With states, at the level
 * that owns its call (the leaf when none does), with the phase context, so it may stay or goto; the
 * call's effect id leaves the owner's list. A missing callback changes nothing but that.
 */
function atCallLevel(
  run: CallbackRun,
  state: unknown,
  effectId: string | undefined,
  value: { readonly callback: ServiceCallback | undefined; readonly arg: unknown; readonly input: unknown },
  det: ServiceCallbackCtx,
): unknown {
  const call = (shared: unknown, phase: PhaseContext | null) =>
    value.callback === undefined ? shared : value.callback(shared, value.arg, value.input, { ...det, ...phase });
  const states = run.def.states;
  if (states === undefined) return call(state, null);
  const owner = phasedState(state).stateTimers.findIndex((keys) => keys.some((key) => key === effectId));
  const returnedAsIs: boolean[] = [];
  const next = runAtLevel(
    phaseRun(run.def, states, run.effects, run.facts, run.env),
    state,
    owner < 0 ? null : owner + 1,
    (shared, phase) => {
      const result = call(shared, phase);
      returnedAsIs.push(result === shared);
      return result;
    },
    effectId ?? null,
  );
  // The shared state returned as it was, for a call no state owned: nothing changed.
  return returnedAsIs[0] === true && owner < 0 ? state : next;
}

function serviceDone(run: CallbackRun, state: unknown, cause: On<"service.onDone">, det: ServiceCallbackCtx) {
  const callback = run.def.services?.[cause.service]?.onDone;
  return {
    next: atCallLevel(run, state, cause.effectId, { callback, arg: cause.result, input: cause.input }, det),
    name: cause.service,
    payload: resultPayload({ input: cause.input, result: cause.result }, cause),
  };
}

function serviceError(run: CallbackRun, state: unknown, cause: On<"service.onError">, det: ServiceCallbackCtx) {
  const callback = run.def.services?.[cause.service]?.onError;
  return {
    next: atCallLevel(run, state, cause.effectId, { callback, arg: cause.error, input: cause.input }, det),
    name: cause.service,
    payload: resultPayload({ input: cause.input, error: cause.error }, cause),
  };
}

/** A late result (ADR-019 B): the owning state is gone, so onStale runs at the leaf, or nothing does. */
function serviceStale(run: CallbackRun, state: unknown, cause: On<"service.stale">, det: ServiceCallbackCtx) {
  const callback = run.def.services?.[cause.service]?.onStale;
  return {
    next: atCallLevel(run, state, cause.effectId, { callback, arg: cause.result, input: cause.input }, det),
    name: cause.service,
    payload: resultPayload({ input: cause.input, result: cause.result }, cause),
  };
}

function linkUpdate(def: StepDef, state: unknown, cause: On<"link.onUpdate">, det: LinkCallbackCtx) {
  const linkDef = def.links?.[cause.link];
  return {
    next:
      linkDef === undefined ? state : onShared(def, state, (s) => linkDef.onUpdate(s, cause.view, cause.sourceId, det)),
    name: cause.link,
    payload: { sourceId: cause.sourceId, view: cause.view },
  };
}

function linkError(def: StepDef, state: unknown, cause: On<"link.onError">, det: LinkCallbackCtx) {
  const onError = def.links?.[cause.link]?.onError;
  return {
    next: onError === undefined ? state : onShared(def, state, (s) => onError(s, cause.error, cause.targetId, det)),
    name: cause.link,
    payload: { targetId: cause.targetId, error: cause.error },
  };
}

function migrate(def: StepDef, cause: On<"migrate">) {
  const migrated = def.migrate ? def.migrate(cause.persisted, cause.fromVersion) : cause.persisted;
  return {
    next: def.restore ? def.restore(migrated) : migrated,
    name: null,
    payload: { fromVersion: cause.fromVersion, toVersion: cause.toVersion },
  };
}

function runCallback(run: CallbackRun, state: unknown, cause: CallbackCause, det: LinkCallbackCtx): CallbackOutcome {
  const { def, env } = run;
  switch (cause.type) {
    case "service.onDone":
      return serviceDone(run, state, cause, callbackCtx(det, env, cause));
    case "service.onError":
      return serviceError(run, state, cause, callbackCtx(det, env, cause));
    case "service.stale":
      return serviceStale(run, state, cause, callbackCtx(det, env, cause));
    case "link.onUpdate":
      return linkUpdate(def, state, cause, det);
    case "link.onError":
      return linkError(def, state, cause, det);
    case "migrate":
      return migrate(def, cause);
  }
}

function stepCallback(def: StepDef, state: unknown, cause: CallbackCause, facts: StepFacts, env: unknown): StepResult {
  const effects = createOutbox(facts.seq);
  const det = { ...facts.ctx, emit: emitVerb(def, effects) };
  const run = { def, effects, facts, env };
  const { next, name, payload } = guarded(facts, () => runCallback(run, state, cause, det));
  const result = {
    state: next,
    handlerState: next,
    effects,
    event: draft({ causeType: cause.type, name, payload }, NOBODY, facts),
  };
  // A late result is journaled even when it changes nothing, so the history shows it arrived (ADR-019 B).
  return cause.type === "service.stale" ? { ...result, alwaysJournal: true } : result;
}

/** A timer fires: its handler runs with no caller and no role; a timer no longer declared is a no-op. */
function stepTimer(
  def: StepDef,
  state: unknown,
  cause: Extract<StepCause, { type: "timer" }>,
  facts: StepFacts,
  env: unknown,
): StepResult {
  const found = findTimerAt(def, phaseOf(def, state), cause.name);
  const effects = createOutbox(facts.seq);
  const base = {
    ...facts.ctx,
    env,
    key: cause.key,
    lateBy: cause.lateBy,
    execute: plainExecute(effects),
    forward: effects.forward,
    emit: emitVerb(def, effects),
    ...timerVerbs(def, effects, facts.ctx),
  };
  const next =
    found === undefined
      ? state
      : guarded(facts, () =>
          runHandler(
            { def, effects, facts, env },
            state,
            found.depth,
            (current, phaseCtx) => {
              const result = found.timer.handler(current, cause.payload, { ...base, ...phaseCtx });
              assertSync(
                result,
                `Timer "${cause.name}" returned a Promise. Handlers must be synchronous — use execute() for async side effects.`,
              );
              return result;
            },
            cause.key,
          ),
        );
  const { id, key, payload, fireAt, lateBy } = cause;
  return {
    state: next,
    handlerState: next,
    effects,
    event: draft(
      { causeType: "timer", name: cause.name, payload: { id, key, payload, fireAt, lateBy } },
      NOBODY,
      facts,
    ),
  };
}

/** One synchronous transition. Init is `stepInit()` (init may be async). */
export function step(def: StepDef, state: unknown, cause: StepCause, facts: StepFacts, env: unknown): StepResult {
  const result = stepCause(def, state, cause, facts, env);
  const emitted = result.effects.getEmitted().map(({ name, payload }) => ({ name, payload }));
  const event = emitted.length === 0 ? result.event : { ...result.event, emitted };
  return { ...result, event: cause.trace === undefined ? event : { ...event, trace: cause.trace } };
}

function stepCause(def: StepDef, state: unknown, cause: StepCause, facts: StepFacts, env: unknown): StepResult {
  switch (cause.type) {
    case "message":
      return stepMessage(def, state, cause, facts, env);
    case "lifecycle.connect":
    case "lifecycle.disconnect":
      return stepLifecycle(def, state, cause, facts, env);
    case "timer":
      return stepTimer(def, state, cause, facts, env);
    default:
      return stepCallback(def, state, cause, facts, env);
  }
}

// --- init ---

/** The persisted state init's result becomes: as it is, or the initial phase for an actor with states. */
export function initialState(def: Pick<StepDef, "states" | "initial">, shared: unknown): unknown {
  return def.states === undefined ? shared : initialPhase(def.states, def.initial, shared);
}

export interface InitCause {
  readonly input: unknown;
  readonly caller: string | null;
  readonly callerType: "user" | "service" | null;
}

/** The first transition: `init(input, { env, link, now, id, random })`, awaited. */
export async function stepInit(
  def: StepDef,
  cause: InitCause,
  facts: StepFacts,
  io: { env: unknown; link: (name: string, id: string) => Promise<unknown> },
): Promise<{ state: unknown; event: JournalDraft }> {
  const init = def.init;
  if (init === undefined)
    throw new ActorKitError("invalid_actor_definition", "This actor has no init: add init(input) to the definition.");
  // Guarded until init's first await (an async init's later part runs outside the guard).
  const shared = await guarded(facts, () => init(cause.input, { env: io.env, link: io.link, ...facts.ctx }));
  return {
    state: initialState(def, shared),
    event: draft(
      { causeType: "init", name: null, payload: cause.input },
      { caller: cause.caller, callerType: cause.callerType, role: null },
      facts,
    ),
  };
}
