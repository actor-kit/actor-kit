/**
 * States with typed locals (ADR-017 §1), the runtime part.
 *
 * An actor with `states` persists `{ shared, phase, local, stateTimers }`: `local` belongs to the
 * current phase (null when the phase has none) and `stateTimers` lists the keys of the timers
 * scheduled with `scope: "state"` in it. A handler returns `ctx.stay(shared, local?)`,
 * `ctx.goto(phase, shared, input?)` or plain `shared` (stay with the same local). Exit drops the
 * local and cancels the phase's state timers; enter builds the new local with `enter(shared, input, ctx)`.
 */

import { z } from "zod";

/** What `ctx.stay` / `ctx.goto` return. `S` is the shared state's type (phantom at runtime). */
export class PhaseTransition<S = unknown> {
  constructor(
    readonly kind: "stay" | "goto",
    readonly shared: S,
    /** goto: the target phase. */
    readonly phase: string | null,
    /** stay: whether a new local was given (`stay(shared)` keeps the current one). */
    readonly hasLocal: boolean,
    /** stay: the new local; goto: the enter input. */
    readonly value: unknown,
  ) {}
}

export function stay<S>(shared: S, ...local: unknown[]): PhaseTransition<S> {
  return new PhaseTransition("stay", shared, null, local.length > 0, local[0]);
}

export function goto<S>(phase: string, shared: S, ...input: unknown[]): PhaseTransition<S> {
  return new PhaseTransition("goto", shared, phase, false, input[0]);
}

const PhasedStateSchema = z.object({
  shared: z.unknown(),
  phase: z.string(),
  local: z.unknown(),
  stateTimers: z.array(z.string()),
});

export type PhasedState = z.infer<typeof PhasedStateSchema>;

/** Parse the persisted state of an actor with `states` (it is stored as JSON, so parse, never assume). */
export function phasedState(state: unknown): PhasedState {
  const parsed = PhasedStateSchema.safeParse(state);
  if (!parsed.success)
    throw new Error(`The state of an actor with states must be { shared, phase, local, stateTimers }`);
  return parsed.data;
}

export interface SafeParser {
  safeParse(data: unknown): { success: true; data: unknown } | { success: false; error: { message: string } };
}

/** A state as the runtime holds it (unknown-typed, bivariant methods). */
export interface StepStateDef {
  readonly local?: SafeParser;
  enter?(shared: unknown, input: unknown, ctx: unknown): unknown;
  readonly messages?: Record<
    string,
    {
      readonly schema: SafeParser;
      handler(state: unknown, payload: unknown, ctx: unknown): unknown;
      guard?(state: unknown, payload: unknown, ctx: unknown): boolean;
    }
  >;
  readonly timers?: Record<
    string,
    { readonly schema: SafeParser; handler(state: unknown, payload: unknown, ctx: unknown): unknown }
  >;
}

/** A local, parsed by the phase's schema (a phase without one has a null local). */
export function parseLocal(phase: string, def: StepStateDef, local: unknown): unknown {
  if (def.local === undefined) return null;
  const parsed = def.local.safeParse(local);
  if (!parsed.success) throw new Error(`State "${phase}": invalid local: ${parsed.error.message}`);
  return parsed.data;
}

/** The declared state for a phase. */
export function stateDef(states: Record<string, StepStateDef>, phase: string): StepStateDef {
  const def = states[phase];
  if (def === undefined) throw new Error(`State "${phase}" is not declared on this actor`);
  return def;
}

/**
 * Whether some state declares the message. Asked once the current state and the roles have not:
 * true means the message was sent in the wrong phase.
 */
export function declaredInSomeState(states: Record<string, StepStateDef>, name: string): boolean {
  return Object.values(states).some((def) => def.messages?.[name] !== undefined);
}
