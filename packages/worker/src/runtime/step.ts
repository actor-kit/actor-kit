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

import type { DeterministicContext, GuardContext, ScheduleOptions } from "@actor-kit/core";
import { parseDuration } from "./duration";
import { createReplayFacts, type Facts, type JournalDraft, type LiveFacts } from "./journal";
import { createOutbox, type UnlinkCall } from "./outbox";
import {
  declaredInAnotherState,
  goto,
  type PhasedState,
  PhaseTransition,
  parseLocal,
  phasedState,
  type StepStateDef,
  stateDef,
  stay,
} from "./phases";
import { resolveRole } from "./roles";
import type { Trace } from "./trace";

// --- Definition (runtime-shaped: unknown-typed, bivariant methods) ---

export interface StepMessageSlot {
  readonly schema: {
    safeParse(data: unknown): { success: true; data: unknown } | { success: false; error: { message: string } };
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
      onDone?(state: unknown, result: unknown, input: unknown, ctx: DeterministicContext): unknown;
      onError?(state: unknown, error: { message: string }, input: unknown, ctx: DeterministicContext): unknown;
    }
  >;
  links?: Record<
    string,
    {
      onUpdate(state: unknown, view: unknown, id: string | undefined, ctx: DeterministicContext): unknown;
      onError?:
        | ((
            state: unknown,
            error: { message: string; code: string },
            id: string | undefined,
            ctx: DeterministicContext,
          ) => unknown)
        | undefined;
      onUnlink?: ((state: unknown, id: string | undefined, ctx: DeterministicContext) => unknown) | undefined;
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

type Caller = { readonly caller: string; readonly callerType: "user" | "service" };

/** A cause that continues a flow carries its trace (ADR-017 §4); it is journaled with the event. */
type Traced = { readonly trace?: Trace | undefined };

export type StepCause = Traced &
  (
    | ({ readonly type: "message"; readonly name: string; readonly payload: unknown; readonly role: string } & Caller)
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
      }
    | {
        readonly type: "service.onError";
        readonly service: string;
        readonly input: unknown;
        readonly effectId?: string | undefined;
        readonly error: { readonly message: string };
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
export function replayStepFacts(facts: Facts): StepFacts & { takeLinkView(name: string, id: string): unknown } {
  const replay = createReplayFacts(facts);
  return {
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
}

// --- Message admission (live only: replay never asks again) ---

export type Admission<M = unknown> =
  | { ok: true; payload: unknown; message: M }
  | { ok: false; error: "message_not_found" | "validation_failed" | "guard_failed"; detail?: string };

/** Admission for an actor that may have states: also `wrong_state`. */
export type StepAdmission<M = unknown> = Admission<M> | { ok: false; error: "wrong_state" };

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
  const inPhase = stateDef(states, current.phase).messages?.[event.type];
  const message = inPhase ?? roleMessages[role]?.[event.type];
  if (message === undefined) {
    const wrong = declaredInAnotherState(states, current.phase, event.type);
    return { ok: false, error: wrong ? "wrong_state" : "message_not_found" };
  }
  const phaseCtx = { ...ctx, phase: current.phase, local: current.local };
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
  if (!parsed.success) return { ok: false, error: "validation_failed", detail: parsed.error.message };
  if (message.guard !== undefined && !message.guard(state, parsed.data, { ...ctx, role })) {
    return { ok: false, error: "guard_failed" };
  }
  return { ok: true, payload: parsed.data, message };
}

// --- step ---

function assertSync(next: unknown, message: string): void {
  if (next instanceof Promise) throw new Error(message);
}

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
    for (const id of ids) next = onUnlink(next, id, facts.ctx);
  });
  return next;
}

/** When a timer fires: `at`, or ctx.now() + `in`. Exactly one of the two. */
function fireAtOf(options: ScheduleOptions, det: DeterministicContext): number {
  if ((options.in === undefined) === (options.at === undefined)) {
    throw new Error("ctx.schedule needs exactly one of `in` and `at`");
  }
  if (options.at !== undefined) {
    if (!Number.isFinite(options.at)) throw new Error(`ctx.schedule: invalid \`at\` ${options.at}`);
    return options.at;
  }
  return det.now() + parseDuration(options.in);
}

/** ctx.emit for a transition: the event must be declared and its payload must parse (ADR-017 §2). */
function emitVerb(def: StepDef, effects: StepEffects): (name: string, payload: unknown) => void {
  return (name, payload) => {
    const schema = def.events?.[name];
    if (schema === undefined) throw new Error(`Event "${name}" is not declared on this actor`);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new Error(`Event "${name}": invalid payload: ${parsed.error.message}`);
    effects.emit(name, parsed.data);
  };
}

/** A timer by name: the current phase's (actors with states), then the top-level ones. */
export function findTimer(def: StepDef, phase: string | null, name: string) {
  const inPhase = phase === null ? undefined : def.states?.[phase]?.timers?.[name];
  return inPhase ?? def.timers?.[name];
}

/** ctx.schedule / ctx.cancel for a transition: the timer must be declared and its payload must parse. */
function timerVerbs(def: StepDef, effects: StepEffects, det: DeterministicContext, phase: string | null = null) {
  return {
    schedule: (name: string, options: ScheduleOptions): void => {
      const timer = findTimer(def, phase, name);
      if (timer === undefined) throw new Error(`Timer "${name}" is not declared on this actor`);
      const parsed = timer.schema.safeParse(options.payload);
      if (!parsed.success) throw new Error(`Timer "${name}": invalid payload: ${parsed.error.message}`);
      effects.schedule({
        name,
        key: options.key ?? null,
        payload: parsed.data ?? null,
        fireAt: fireAtOf(options, det),
      });
    },
    cancel: (key: string): void => effects.cancel(key),
  };
}

// --- States (ADR-017 §1) ---

/** What a handler of an actor with states sees besides the usual context. */
interface PhaseContext {
  readonly phase: string;
  readonly local: unknown;
  readonly stay: typeof stay;
  readonly goto: typeof goto;
  readonly schedule: (name: string, options: ScheduleOptions) => void;
}

/**
 * ctx.schedule for a phase: `scope: "state"` timers get the key `${phase}:${name}` unless given one,
 * and are recorded so leaving the phase cancels them.
 */
function scopedSchedule(
  base: (name: string, options: ScheduleOptions) => void,
  phase: string,
  scoped: string[],
): (name: string, options: ScheduleOptions) => void {
  return (name, options) => {
    if (options.scope !== "state") return base(name, options);
    const key = options.key ?? `${phase}:${name}`;
    base(name, { ...options, key });
    scoped.push(key);
  };
}

interface PhaseRun {
  readonly def: StepDef;
  readonly states: Record<string, StepStateDef>;
  readonly effects: StepEffects;
  readonly facts: StepFacts;
  readonly env: unknown;
}

/** Leave the current phase (cancel its state timers, drop its local) and enter `phase`. */
function enterPhase(
  run: PhaseRun,
  shared: unknown,
  phase: string,
  input: unknown,
  leaving: readonly string[],
): PhasedState {
  const target = stateDef(run.states, phase);
  for (const key of leaving) run.effects.cancel(key);
  const scoped: string[] = [];
  const verbs = timerVerbs(run.def, run.effects, run.facts.ctx, phase);
  const local =
    target.enter === undefined
      ? null
      : target.enter(shared, input, {
          ...run.facts.ctx,
          env: run.env,
          phase,
          execute: run.effects.execute,
          forward: run.effects.forward,
          emit: emitVerb(run.def, run.effects),
          cancel: verbs.cancel,
          schedule: scopedSchedule(verbs.schedule, phase, scoped),
        });
  assertSync(local, `State "${phase}": enter returned a Promise. Handlers must be synchronous.`);
  return { shared, phase, local: parseLocal(phase, target, local), stateTimers: scoped };
}

/** The persisted state after a handler of an actor with states returned `result`. */
function settlePhase(run: PhaseRun, current: PhasedState, result: unknown, scoped: readonly string[]): PhasedState {
  const stateTimers = [...current.stateTimers, ...scoped];
  if (!(result instanceof PhaseTransition)) return { ...current, shared: result, stateTimers };
  if (result.kind === "goto" && result.phase !== null) {
    return enterPhase(run, result.shared, result.phase, result.value, stateTimers);
  }
  const local = result.hasLocal
    ? parseLocal(current.phase, stateDef(run.states, current.phase), result.value)
    : current.local;
  return { ...current, shared: result.shared, local, stateTimers };
}

/**
 * Run a handler: as is for an actor without states; for one with states, on the shared state with
 * the phase context, its result settling the phase (stay, goto, or plain shared = stay).
 */
function runHandler(
  run: Omit<PhaseRun, "states">,
  state: unknown,
  call: (state: unknown, phase: PhaseContext | null) => unknown,
  firedKey: string | null = null,
): unknown {
  const states = run.def.states;
  if (states === undefined) return call(state, null);
  const parsed = phasedState(state);
  const current = { ...parsed, stateTimers: parsed.stateTimers.filter((key) => key !== firedKey) };
  const scoped: string[] = [];
  const verbs = timerVerbs(run.def, run.effects, run.facts.ctx, current.phase);
  const result = call(current.shared, {
    phase: current.phase,
    local: current.local,
    stay,
    goto,
    schedule: scopedSchedule(verbs.schedule, current.phase, scoped),
  });
  assertSync(result, "A handler returned a Promise. Handlers must be synchronous.");
  return settlePhase({ ...run, states }, current, result, scoped);
}

/** For handlers that only see the shared state (lifecycle, services, links): the result is the new shared state. */
function onShared(def: StepDef, state: unknown, fn: (shared: unknown) => unknown): unknown {
  if (def.states === undefined) return fn(state);
  const current = phasedState(state);
  const next = fn(current.shared);
  return next === current.shared ? state : { ...current, shared: next };
}

/** The message's handler: the current phase's, then the role's top-level one. */
/** The phase an actor with states is in (null without states). */
export function phaseOf(def: StepDef, state: unknown): string | null {
  return def.states === undefined ? null : phasedState(state).phase;
}

export function messageSlot(def: StepDef, state: unknown, role: string, name: string) {
  const phase = def.states === undefined ? null : phasedState(state).phase;
  const inPhase = phase === null ? undefined : def.states?.[phase]?.messages?.[name];
  return inPhase ?? def.messages?.[role]?.[name];
}

function stepMessage(
  def: StepDef,
  state: unknown,
  cause: Extract<StepCause, { type: "message" }>,
  facts: StepFacts,
  env: unknown,
): StepResult {
  const slot = messageSlot(def, state, cause.role, cause.name);
  if (slot === undefined) throw new Error(`Message "${cause.name}" is not defined for role "${cause.role}"`);
  const effects = createOutbox();
  const base = {
    ...facts.ctx,
    caller: cause.caller,
    callerType: cause.callerType,
    role: cause.role,
    env,
    execute: effects.execute,
    link: effects.link,
    unlink: effects.unlink,
    forward: effects.forward,
    emit: emitVerb(def, effects),
    ...timerVerbs(def, effects, facts.ctx),
  };
  const handlerState = runHandler({ def, effects, facts, env }, state, (current, phase) => {
    const result = slot.handler(current, cause.payload, phase === null ? base : { ...base, ...phase });
    assertSync(
      result,
      `Message handler for "${cause.name}" returned a Promise. Handlers must be synchronous — use execute() for async side effects.`,
    );
    return result;
  });
  const next = applyUnlinks(def, handlerState, effects, facts);
  return {
    state: next,
    handlerState,
    effects,
    event: draft(
      { causeType: "message", name: cause.name, payload: cause.payload },
      { caller: cause.caller, callerType: cause.callerType, role: cause.role },
      facts,
    ),
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
  const effects = createOutbox();
  const who = { caller: cause.caller, callerType: cause.callerType };
  const event = cause.callerConnections === undefined ? who : { ...who, callerConnections: cause.callerConnections };
  const next =
    handler === undefined
      ? state
      : onShared(def, state, (shared) => {
          const result = handler(shared, event, {
            ...facts.ctx,
            ...who,
            env,
            execute: effects.execute,
            forward: effects.forward,
            ...timerVerbs(def, effects, facts.ctx),
          });
          assertSync(result, `lifecycle.${which} returned a Promise. Handlers must be synchronous.`);
          return result;
        });
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

function withEffectId<P extends object>(payload: P, effectId: string | undefined): P | (P & { effectId: string }) {
  return effectId === undefined ? payload : { ...payload, effectId };
}

function serviceDone(def: StepDef, state: unknown, cause: On<"service.onDone">, det: DeterministicContext) {
  const onDone = def.services?.[cause.service]?.onDone;
  return {
    next: onDone === undefined ? state : onShared(def, state, (s) => onDone(s, cause.result, cause.input, det)),
    name: cause.service,
    payload: withEffectId({ input: cause.input, result: cause.result }, cause.effectId),
  };
}

function serviceError(def: StepDef, state: unknown, cause: On<"service.onError">, det: DeterministicContext) {
  const onError = def.services?.[cause.service]?.onError;
  return {
    next:
      onError === undefined
        ? state
        : onShared(def, state, (s) => onError(s, { message: cause.error.message }, cause.input, det)),
    name: cause.service,
    payload: withEffectId({ input: cause.input, error: cause.error }, cause.effectId),
  };
}

function linkUpdate(def: StepDef, state: unknown, cause: On<"link.onUpdate">, det: DeterministicContext) {
  const linkDef = def.links?.[cause.link];
  return {
    next:
      linkDef === undefined ? state : onShared(def, state, (s) => linkDef.onUpdate(s, cause.view, cause.sourceId, det)),
    name: cause.link,
    payload: { sourceId: cause.sourceId, view: cause.view },
  };
}

function linkError(def: StepDef, state: unknown, cause: On<"link.onError">, det: DeterministicContext) {
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

function runCallback(def: StepDef, state: unknown, cause: CallbackCause, det: DeterministicContext): CallbackOutcome {
  switch (cause.type) {
    case "service.onDone":
      return serviceDone(def, state, cause, det);
    case "service.onError":
      return serviceError(def, state, cause, det);
    case "link.onUpdate":
      return linkUpdate(def, state, cause, det);
    case "link.onError":
      return linkError(def, state, cause, det);
    case "migrate":
      return migrate(def, cause);
  }
}

function stepCallback(def: StepDef, state: unknown, cause: CallbackCause, facts: StepFacts): StepResult {
  const { next, name, payload } = runCallback(def, state, cause, facts.ctx);
  return {
    state: next,
    handlerState: next,
    effects: createOutbox(),
    event: draft({ causeType: cause.type, name, payload }, NOBODY, facts),
  };
}

/** A timer fires: its handler runs with no caller and no role; a timer no longer declared is a no-op. */
function stepTimer(
  def: StepDef,
  state: unknown,
  cause: Extract<StepCause, { type: "timer" }>,
  facts: StepFacts,
  env: unknown,
): StepResult {
  const phase = def.states === undefined ? null : phasedState(state).phase;
  const timer = findTimer(def, phase, cause.name);
  const effects = createOutbox();
  const base = {
    ...facts.ctx,
    env,
    key: cause.key,
    lateBy: cause.lateBy,
    execute: effects.execute,
    forward: effects.forward,
    emit: emitVerb(def, effects),
    ...timerVerbs(def, effects, facts.ctx),
  };
  const next =
    timer === undefined
      ? state
      : runHandler(
          { def, effects, facts, env },
          state,
          (current, phaseCtx) => {
            const result = timer.handler(current, cause.payload, phaseCtx === null ? base : { ...base, ...phaseCtx });
            assertSync(
              result,
              `Timer "${cause.name}" returned a Promise. Handlers must be synchronous — use execute() for async side effects.`,
            );
            return result;
          },
          cause.key,
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
      return stepCallback(def, state, cause, facts);
  }
}

// --- init ---

/** An actor with states starts in `initial`, which has no local (nothing to build it from yet). */
function initialPhase(states: Record<string, StepStateDef>, initial: string | undefined, shared: unknown): PhasedState {
  if (initial === undefined) throw new Error("An actor with states needs `initial`");
  if (stateDef(states, initial).local !== undefined) {
    throw new Error(`The initial state "${initial}" cannot have a local: it is entered before any input exists`);
  }
  return { shared, phase: initial, local: null, stateTimers: [] };
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
  if (def.init === undefined) throw new Error("This actor has no init");
  const shared = await def.init(cause.input, { env: io.env, link: io.link, ...facts.ctx });
  const state = def.states === undefined ? shared : initialPhase(def.states, def.initial, shared);
  return {
    state,
    event: draft(
      { causeType: "init", name: null, payload: cause.input },
      { caller: cause.caller, callerType: cause.callerType, role: null },
      facts,
    ),
  };
}
