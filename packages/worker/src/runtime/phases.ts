/**
 * States (ADR-017 §1, hierarchical in ADR-019 A), the runtime part.
 *
 * An actor with `states` persists `{ shared, phase, locals, stateTimers }`: `phase` is the active path
 * from the root to a leaf (`["playing", "window"]`), `locals[i]` the local of level i (null when it
 * declares none) and `stateTimers[i]` the keys of the `scope: "state"` timers level i owns. A flat actor
 * is the depth-1 case. A handler returns `ctx.stay(shared, local?)`, `ctx.goto(path, shared, input?)` or
 * plain `shared` (stay). The transition table is in docs/adrs/019-hierarchical-states-and-history-at-scale.md.
 */

import { ActorKitError, mergeLocals, type ParseableSchema, parseSchema } from "@actor-kit/core";
import { z } from "zod";

/** A state's path: a top-level name, or the names from the root down. */
export type PathInput = string | readonly string[];

/** What `ctx.stay` / `ctx.goto` return. `S` is the shared state's type (phantom at runtime). */
export class PhaseTransition<S = unknown> {
  constructor(
    readonly kind: "stay" | "goto",
    readonly shared: S,
    /** goto: the target, as given (a name or a path). */
    readonly phase: PathInput | null,
    /** stay: whether a new local was given (`stay(shared)` keeps the current one). */
    readonly hasLocal: boolean,
    /** stay: the new local; goto: the enter input. */
    readonly value: unknown,
    /** goto: new locals for kept levels, by dotted path (row 21); null when none are given. */
    readonly locals: Readonly<Record<string, unknown>> | null = null,
  ) {}
}

export function stay<S>(shared: S, ...local: unknown[]): PhaseTransition<S> {
  return new PhaseTransition("stay", shared, null, local.length > 0, local[0]);
}

const GotoOptionsSchema = z.strictObject({ locals: z.record(z.string(), z.unknown()).optional() });

/** goto's options, parsed where they enter the runtime: the kept levels' new locals, if any. */
function gotoLocals(options: unknown): Readonly<Record<string, unknown>> | null {
  if (options === undefined) return null;
  const parsed = GotoOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new ActorKitError(
      "invalid_goto_locals",
      `goto's options are { locals?: { "<kept level>": local } }: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data.locals ?? null;
}

/** `goto(target, shared, input?, { locals }?)`. */
export function goto<S>(phase: PathInput, shared: S, ...args: unknown[]): PhaseTransition<S> {
  return new PhaseTransition("goto", shared, phase, false, args[0], gotoLocals(args[1]));
}

const PhasedStateSchema = z
  .object({
    shared: z.unknown(),
    phase: z.array(z.string()).min(1),
    locals: z.array(z.unknown()),
    stateTimers: z.array(z.array(z.string())),
  })
  .refine((s) => s.locals.length === s.phase.length && s.stateTimers.length === s.phase.length, {
    message: "one local and one timer list per level",
  });

/** The 0.2 (ADR-017) shape: a flat phase name, one local, one timer list. */
const FlatStateSchema = z.object({
  shared: z.unknown(),
  phase: z.string(),
  local: z.unknown(),
  stateTimers: z.array(z.string()),
});

export interface PhasedState {
  readonly shared: unknown;
  readonly phase: string[];
  readonly locals: unknown[];
  readonly stateTimers: string[][];
}

/**
 * Parse the persisted state of an actor with states (it is stored as JSON, so parse, never assume).
 * The 0.2 flat shape is read as its one-element path.
 */
export function phasedState(state: unknown): PhasedState {
  const parsed = PhasedStateSchema.safeParse(state);
  if (parsed.success) return parsed.data;
  const flat = FlatStateSchema.safeParse(state);
  if (flat.success) {
    const { shared, phase, local, stateTimers } = flat.data;
    return { shared, phase: [phase], locals: [local], stateTimers: [stateTimers] };
  }
  throw new ActorKitError(
    "invalid_phased_state",
    `The state of an actor with states must be { shared, phase, local, stateTimers } (0.2: a flat phase name) or { shared, phase, locals, stateTimers } (a path, one local and one timer list per level): ${parsed.error.issues.map((i) => i.message).join("; ")}`,
  );
}

/** The state as loaded from storage: the 0.2 flat shape of an actor with states becomes its path shape. */
export function upgradePhased(def: { readonly states?: unknown }, state: unknown): unknown {
  if (def.states === undefined || !FlatStateSchema.safeParse(state).success) return state;
  return phasedState(state);
}

/** A schema the runtime parses with (any Standard Schema, ADR-024). */
export type SafeParser = ParseableSchema;

/** A state as the runtime holds it (unknown-typed, bivariant methods). */
export interface StepStateDef {
  readonly local?: SafeParser;
  /** Set (by `kit.in(path).state()`) when the state declares an enter input: it can only be a goto target. */
  readonly input?: unknown;
  enter?(shared: unknown, input: unknown, ctx: unknown): unknown;
  exit?(shared: unknown, ctx: unknown): unknown;
  readonly messages?: Record<
    string,
    {
      readonly schema: SafeParser;
      handler(state: unknown, payload: unknown, ctx: unknown): unknown;
      guard?(state: unknown, payload: unknown, ctx: unknown): boolean;
      readonly roles?: readonly string[] | undefined;
    }
  >;
  readonly timers?: Record<
    string,
    { readonly schema: SafeParser; handler(state: unknown, payload: unknown, ctx: unknown): unknown }
  >;
  readonly initial?: string;
  readonly states?: Record<string, StepStateDef>;
}

/** Nested locals merge as views see them (`localOf`); the function lives in @actor-kit/core (zod-free). */
export { mergeLocals };

/** A path as a dotted name, for messages and timer keys (`playing.window`). */
export function dotted(path: readonly string[]): string {
  return path.join(".");
}

/** A goto target or `in()` argument as a path. */
export function pathOf(target: PathInput): string[] {
  return typeof target === "string" ? [target] : [...target];
}

/** A local, parsed by the level's schema (a level without one has a null local). */
export function parseLocal(path: readonly string[], def: StepStateDef, local: unknown): unknown {
  if (def.local === undefined) return null;
  const parsed = parseSchema(def.local, local);
  if (!parsed.success) {
    throw new ActorKitError("invalid_local", `State "${dotted(path)}": invalid local: ${parsed.message}`);
  }
  return parsed.data;
}

/** The declared states along a path, root first. */
export function levelsOf<D extends { readonly states?: Record<string, D> }>(
  states: Readonly<Record<string, D>>,
  path: readonly string[],
): D[] {
  const levels: D[] = [];
  let children: Readonly<Record<string, D>> | undefined = states;
  for (const name of path) {
    const def: D | undefined = children?.[name];
    if (def === undefined) {
      throw new ActorKitError(
        "undeclared_state",
        `State "${dotted(path)}" is not declared on this actor. Declare it in setup({ states }) and in the actor's states.`,
      );
    }
    levels.push(def);
    children = def.states;
  }
  return levels;
}

/** The declared state at a path. */
export function stateDef<D extends { readonly states?: Record<string, D> }>(
  states: Readonly<Record<string, D>>,
  path: PathInput,
): D {
  const levels = levelsOf(states, pathOf(path));
  const def = levels.at(-1);
  if (def === undefined) throw new ActorKitError("undeclared_state", "A state path needs at least one name.");
  return def;
}

/** The `initial` child of a state with child states. */
export function initialChild(def: StepStateDef, path: readonly string[]): string {
  if (def.initial === undefined) {
    throw new ActorKitError(
      "missing_initial",
      `State "${dotted(path)}" has child states and needs \`initial\`: add initial: "<child>" to it.`,
    );
  }
  return def.initial;
}

/**
 * The states that declare the message, as dotted paths in declaration order (depth first). Asked once
 * the active path and the roles have not: any means the message was sent in the wrong state.
 */
export function statesDeclaring(states: Record<string, StepStateDef>, name: string, prefix: string[] = []): string[] {
  return Object.entries(states).flatMap(([key, def]) => {
    const path = [...prefix, key];
    const here = def.messages?.[name] === undefined ? [] : [dotted(path)];
    return def.states === undefined ? here : [...here, ...statesDeclaring(def.states, name, path)];
  });
}

/** The innermost level on the path that has `pick`, with its depth (1-based); undefined when none does. */
export function innermost<D extends { readonly states?: Record<string, D> }, T>(
  states: Readonly<Record<string, D>>,
  path: readonly string[],
  pick: (def: D) => T | undefined,
): { readonly found: T; readonly depth: number } | undefined {
  for (const [i, level] of [...levelsOf(states, path).entries()].reverse()) {
    const found = pick(level);
    if (found !== undefined) return { found, depth: i + 1 };
  }
  return undefined;
}

/** The longest common prefix of the active path and a goto target, kept by the goto: at most target.length - 1. */
export function keptDepth(active: readonly string[], target: readonly string[]): number {
  let depth = 0;
  while (depth < target.length - 1 && active[depth] === target[depth]) depth++;
  return depth;
}
