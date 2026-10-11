/**
 * Moving through a state tree (ADR-019 A): running a handler at its level, settling what it returned
 * (stay, goto, or the next shared state), and the exits and enters a goto makes. The rows of the
 * transition table in docs/adrs/019-hierarchical-states-and-history-at-scale.md are implemented here.
 * The step core (`step.ts`) supplies the effect verbs; nothing here touches storage.
 */

import { ActorKitError, type ScheduleOptions } from "@actor-kit/core";
import {
  dotted,
  goto,
  initialChild,
  keptDepth,
  mergeLocals,
  type PathInput,
  type PhasedState,
  PhaseTransition,
  parseLocal,
  pathOf,
  phasedState,
  type StepStateDef,
  stateDef,
  stay,
} from "./phases";

export function assertSync(next: unknown, message: string): void {
  if (next instanceof Promise) throw new ActorKitError("async_handler", message);
}

/** ctx.schedule / ctx.cancel for a level: timers are looked up from it outward. */
export interface TimerVerbs {
  schedule(name: string, options: ScheduleOptions): void;
  cancel(key: string): void;
}

/** What moving through the tree needs from the transition it runs in. */
export interface PhaseRun {
  readonly states: Record<string, StepStateDef>;
  /** The context enter and exit share: now/id/random, env, execute, forward, emit. */
  readonly base: Readonly<Record<string, unknown>>;
  verbs(path: readonly string[]): TimerVerbs;
}

/** What a handler of an actor with states sees besides the usual context. */
export interface PhaseContext {
  readonly phase: readonly string[];
  readonly local: unknown;
  readonly stay: typeof stay;
  readonly goto: typeof goto;
  readonly schedule: (name: string, options: ScheduleOptions) => void;
}

/**
 * ctx.schedule at a level: a `scope: "state"` timer belongs to the level (its key defaults to
 * `<dotted path>:<timer>`) and is recorded in `owned`, so leaving the level cancels it. `owned` is
 * null in `exit`, which cannot schedule one: its level is being left.
 */
function scopedSchedule(
  verbs: TimerVerbs,
  path: readonly string[],
  owned: string[] | null,
): (name: string, options: ScheduleOptions) => void {
  return (name, options) => {
    if (options.scope !== "state") return verbs.schedule(name, options);
    if (owned === null) {
      throw new ActorKitError(
        "invalid_schedule",
        `State "${dotted(path)}": exit cannot schedule a scope: "state" timer, because its state is being left. Schedule it in the next state's enter.`,
      );
    }
    const key = options.key ?? `${dotted(path)}:${name}`;
    verbs.schedule(name, { ...options, key });
    owned.push(key);
  };
}

function invalidTransition(path: readonly string[], hook: "enter" | "exit", allowed: string): ActorKitError {
  return new ActorKitError("invalid_transition", `State "${dotted(path)}": ${hook} ${allowed}; it cannot goto.`);
}

/** Leave the innermost level (row 14): its exit runs, its scoped timers are cancelled, its local is dropped. */
function exitLevel(run: PhaseRun, state: PhasedState): PhasedState {
  const path = state.phase;
  const def = stateDef(run.states, path);
  const verbs = run.verbs(path);
  let shared = state.shared;
  if (def.exit !== undefined) {
    const result = def.exit(shared, {
      ...run.base,
      phase: path,
      local: mergeLocals(state.locals),
      cancel: verbs.cancel,
      schedule: scopedSchedule(verbs, path, null),
    });
    assertSync(result, `State "${dotted(path)}": exit returned a Promise. Handlers must be synchronous.`);
    if (result instanceof PhaseTransition) throw invalidTransition(path, "exit", "returns the next shared state");
    shared = result;
  }
  for (const key of state.stateTimers.slice(-1).flat()) verbs.cancel(key);
  return {
    shared,
    phase: path.slice(0, -1),
    locals: state.locals.slice(0, -1),
    stateTimers: state.stateTimers.slice(0, -1),
  };
}

/**
 * Enter a level below the current path (row 15): its enter builds its local (or returns
 * `stay(shared, local)`); only a goto's target gets the input (row 13).
 */
function enterLevel(
  run: PhaseRun,
  state: PhasedState,
  path: readonly string[],
  input: { readonly value: unknown } | null,
): PhasedState {
  const def = stateDef(run.states, path);
  if (input === null && def.input !== undefined) {
    throw new ActorKitError(
      "missing_state_input",
      `State "${dotted(path)}" declares an enter input, so only a goto that targets it can enter it. Goto "${dotted(path)}" itself (the input goes to the target), or drop its input.`,
    );
  }
  const owned: string[] = [];
  const verbs = run.verbs(path);
  let shared = state.shared;
  let local: unknown = null;
  if (def.enter !== undefined) {
    const out = def.enter(shared, input?.value, {
      ...run.base,
      phase: [...path],
      local: mergeLocals(state.locals),
      cancel: verbs.cancel,
      schedule: scopedSchedule(verbs, path, owned),
      stay,
      goto,
    });
    assertSync(out, `State "${dotted(path)}": enter returned a Promise. Handlers must be synchronous.`);
    if (out instanceof PhaseTransition) {
      if (out.kind === "goto") throw invalidTransition(path, "enter", "returns its local or ctx.stay(shared, local)");
      shared = out.shared;
      local = out.hasLocal ? out.value : null;
    } else {
      local = out;
    }
  }
  return {
    shared,
    phase: [...path],
    locals: [...state.locals, parseLocal(path, def, local)],
    stateTimers: [...state.stateTimers, owned],
  };
}

/** Enter each level's `initial` child down to a leaf (rows 7, 11, 12). */
function descend(run: PhaseRun, state: PhasedState): PhasedState {
  let next = state;
  let def = stateDef(run.states, next.phase);
  while (def.states !== undefined) {
    next = enterLevel(run, next, [...next.phase, initialChild(def, next.phase)], null);
    def = stateDef(run.states, next.phase);
  }
  return next;
}

/** A goto (rows 7-13): exit below the kept prefix, innermost first; enter the target's levels, outermost first. */
function gotoPath(run: PhaseRun, state: PhasedState, target: PathInput, input: unknown): PhasedState {
  const path = pathOf(target);
  const kept = keptDepth(state.phase, path);
  let next = state;
  while (next.phase.length > kept) next = exitLevel(run, next);
  for (let depth = kept + 1; depth <= path.length; depth++) {
    next = enterLevel(run, next, path.slice(0, depth), depth === path.length ? { value: input } : null);
  }
  return descend(run, next);
}

/**
 * The persisted state after a handler at `depth` returned `result` (rows 5-7): plain shared or
 * stay(shared) keep every local; stay(shared, local) updates each level up to `depth` that declares a
 * local, from the one merged value; goto moves. `owned`: the scoped timers the handler scheduled.
 */
function settle(
  run: PhaseRun,
  current: PhasedState,
  result: unknown,
  depth: number,
  owned: readonly string[],
): PhasedState {
  const stateTimers = current.stateTimers.map((keys, i) =>
    i === depth - 1 ? [...new Set([...keys, ...owned])] : keys,
  );
  const at = { ...current, stateTimers };
  if (!(result instanceof PhaseTransition)) return { ...at, shared: result };
  // A goto carries its target; a stay has none.
  if (result.phase !== null) return gotoPath(run, { ...at, shared: result.shared }, result.phase, result.value);
  if (!result.hasLocal) return { ...at, shared: result.shared };
  const locals = at.locals.map((local, i) => {
    const path = current.phase.slice(0, i + 1);
    return i < depth ? parseLocal(path, stateDef(run.states, path), result.value) : local;
  });
  return { ...at, shared: result.shared, locals };
}

/**
 * Run a handler declared at `depth` (null: a top-level one, which runs at the leaf) on the shared
 * state, with the phase context (rows 2, 4, 16, 17); `firedKey` leaves its owner's timer list.
 */
export function runAtLevel(
  run: PhaseRun,
  state: unknown,
  depth: number | null,
  call: (shared: unknown, phase: PhaseContext) => unknown,
  firedKey: string | null,
): PhasedState {
  const parsed = phasedState(state);
  const current = { ...parsed, stateTimers: parsed.stateTimers.map((keys) => keys.filter((key) => key !== firedKey)) };
  const level = depth ?? current.phase.length;
  const levelPath = current.phase.slice(0, level);
  const owned: string[] = [];
  const result = call(current.shared, {
    phase: current.phase,
    local: mergeLocals(current.locals.slice(0, level)),
    stay,
    goto,
    schedule: scopedSchedule(run.verbs(levelPath), levelPath, owned),
  });
  // `call` checks the handler returned synchronously (it names the message or timer).
  return settle(run, current, result, level, owned);
}

/**
 * The state init's result becomes (row 1): the root `initial` and each level's `initial` child,
 * without enter (no input exists yet), so none of them may declare a local.
 */
export function initialPhase(
  states: Record<string, StepStateDef>,
  initial: string | undefined,
  shared: unknown,
): PhasedState {
  if (initial === undefined) {
    throw new ActorKitError(
      "missing_initial",
      'An actor with states needs `initial`: add initial: "<state>" to the definition.',
    );
  }
  const phase = [initial];
  for (;;) {
    const def = stateDef(states, phase);
    if (def.local !== undefined) {
      throw new ActorKitError(
        "initial_state_local",
        `The initial state "${dotted(phase)}" cannot have a local: it is entered before any input exists`,
      );
    }
    if (def.states === undefined) break;
    phase.push(initialChild(def, phase));
  }
  return { shared, phase, locals: phase.map(() => null), stateTimers: phase.map(() => []) };
}
