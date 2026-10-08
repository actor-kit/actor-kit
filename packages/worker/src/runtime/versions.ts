/**
 * The typed version chain (ADR-015 D5), replacing `version` + `migrate`:
 *
 *   versions: [
 *     version(1, V1State),
 *     version(2, V2State, { state: (s: V1) => …, events: { JOIN: (p) => ({ ...p, avatar: null }) } }),
 *     version(3, V3State, { rebuild: "replay" }),
 *   ]
 *
 * - Each version's schema describes the persisted (serialized) state at that version; persisted
 *   state is parsed with the schema of the version that wrote it, and every step's output with
 *   its own version's schema.
 * - `state` steps the previous version's state to this one (no step: it must already match).
 * - `events` upcasts journaled message payloads, by message name, when replaying events written
 *   before this version.
 * - `rebuild: "replay"` rebuilds the state by replaying the journal under the new handlers instead
 *   of stepping it (needs the journal).
 *
 * compileVersions() turns the chain into what the runtime runs; toRuntimeDef() applies it to a
 * contract's definition (and refuses the old `version` / `migrate` options: there is no shim).
 */

import { z } from "zod";

type Payload = Record<string, unknown>;

export interface VersionOptions<S, P> {
  /** From the previous version's state to this version's. */
  readonly state?: (previous: P) => S;
  /** Payload upcasts for messages journaled before this version, by message name. */
  readonly events?: Readonly<Record<string, (payload: Payload) => Payload>>;
  /** Rebuild the state by replaying the journal under the new handlers. */
  readonly rebuild?: "replay";
}

export interface VersionDef<N extends number = number, S = unknown, P = unknown> extends VersionOptions<S, P> {
  readonly version: N;
  readonly schema: z.ZodType<S>;
}

/** One version of an actor's state. Steps are typed against the previous version's state. */
export function version<const N extends number, S, P = unknown>(
  n: N,
  schema: z.ZodType<S>,
  options: VersionOptions<S, P> = {},
): VersionDef<N, S, P> {
  return { version: n, schema, ...options };
}

// --- Chain typing (checked by defineActor) ---

type StateOf<V> = V extends { readonly schema: z.ZodType<infer S> } ? S : never;
type PreviousOf<V> = V extends { readonly state?: (previous: infer P) => unknown } ? P : unknown;

/** true when every step's `state` takes the previous version's state. */
export type ChainIsTyped<T extends readonly unknown[]> = T extends readonly [infer A, infer B, ...infer Rest]
  ? [StateOf<A>] extends [PreviousOf<B>]
    ? ChainIsTyped<readonly [B, ...Rest]>
    : false
  : true;

/** The state of the chain's last (current) version. */
export type CurrentState<T extends readonly unknown[]> = T extends readonly [...unknown[], infer Last]
  ? StateOf<Last>
  : never;

// --- Runtime ---

interface SafeParser {
  safeParse(data: unknown): { success: true; data: unknown } | { success: false; error: { message: string } };
}

const isFunction = (value: unknown): value is (input: never) => unknown => typeof value === "function";
const isRecord = (value: unknown): value is Payload =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSchema = (value: unknown): value is SafeParser =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "safeParse") === "function";

const StepSchema = z.object({
  version: z.number().int().min(1),
  schema: z.custom<SafeParser>(isSchema, "schema must be a Zod schema"),
  state: z.custom<(previous: unknown) => unknown>(isFunction).optional(),
  events: z.record(z.string(), z.custom<(payload: Payload) => Payload>(isFunction)).optional(),
  rebuild: z.literal("replay").optional(),
});
type Step = z.infer<typeof StepSchema>;
const ChainSchema = z.array(StepSchema).min(1);

export interface CompiledVersions {
  /** The current version: the chain's last. */
  readonly version: number;
  readonly versions: readonly number[];
  /** The newest version that rebuilds by replay, or null. */
  readonly rebuildVersion: number | null;
  /** Step persisted state from `fromVersion` to the current version (not across a rebuild). */
  migrate(persisted: unknown, fromVersion: number): unknown;
  /** Upcast a message payload journaled at `fromVersion` through every later version. */
  upcast(message: string, payload: unknown, fromVersion: number): unknown;
}

function parseAt(step: Step, state: unknown): unknown {
  const parsed = step.schema.safeParse(state);
  if (!parsed.success) throw new Error(`State does not match version ${step.version}: ${parsed.error.message}`);
  return parsed.data;
}

function validChain(chain: unknown): Step[] {
  const parsed = ChainSchema.safeParse(chain);
  if (!parsed.success) throw new Error(`Invalid versions: ${parsed.error.message}`);
  const steps = parsed.data;
  steps.forEach((step, i) => {
    const previous = steps[i - 1];
    if (previous !== undefined && step.version <= previous.version) {
      throw new Error(`Invalid versions: ${step.version} must come after ${previous.version}, in increasing order`);
    }
  });
  const [first] = steps;
  if (first?.state !== undefined || first?.rebuild !== undefined) {
    throw new Error("Invalid versions: the first version has no previous state to step from");
  }
  return steps;
}

export function compileVersions(chain: unknown): CompiledVersions {
  const steps = validChain(chain);
  const versions = steps.map((s) => s.version);
  const current = Math.max(...versions);
  const rebuilds = steps.filter((s) => s.rebuild === "replay").map((s) => s.version);
  return {
    version: current,
    versions,
    rebuildVersion: rebuilds.length === 0 ? null : Math.max(...rebuilds),
    migrate(persisted, fromVersion) {
      const from = steps.findIndex((s) => s.version === fromVersion);
      const origin = steps[from];
      if (origin === undefined) throw new Error(`There is no path from version ${fromVersion} to version ${current}`);
      let state = parseAt(origin, persisted);
      for (const step of steps.slice(from + 1)) {
        if (step.rebuild === "replay")
          throw new Error(`Version ${step.version} rebuilds by replay; it cannot be stepped to`);
        state = parseAt(step, step.state === undefined ? state : step.state(state));
      }
      return state;
    },
    upcast(message, payload, fromVersion) {
      let next = payload;
      for (const step of steps.filter((s) => s.version > fromVersion)) {
        const upcast = step.events?.[message];
        if (upcast !== undefined && isRecord(next)) next = upcast(next);
      }
      return next;
    },
  };
}

/** What the runtime reads from a definition once its version chain is compiled. */
export interface RuntimeVersioning {
  readonly version: number;
  readonly knownVersions?: readonly number[];
  readonly rebuildVersion?: number | null;
  migrate?(persisted: unknown, fromVersion: number): unknown;
  upcast?(message: string, payload: unknown, fromVersion: number): unknown;
}

/**
 * A contract's definition with its version chain compiled. A definition without `versions` is at
 * version 1. The pre-ADR-015 `version` / `migrate` options are refused: `versions` replaces them.
 */
export function toRuntimeDef<D extends object>(def: D): D & RuntimeVersioning {
  if ("version" in def || "migrate" in def) {
    throw new Error(
      '"version" and "migrate" are replaced by versions: [version(n, Schema, { state, events, rebuild })] (ADR-015 D5)',
    );
  }
  const chain: unknown = Reflect.get(def, "versions");
  if (chain === undefined) return { ...def, version: 1 };
  const compiled = compileVersions(chain);
  if (compiled.rebuildVersion !== null && Reflect.get(def, "journal") === false) {
    throw new Error('rebuild: "replay" needs the journal (this actor has journal: false)');
  }
  return {
    ...def,
    version: compiled.version,
    knownVersions: compiled.versions,
    rebuildVersion: compiled.rebuildVersion,
    migrate: compiled.migrate,
    upcast: compiled.upcast,
  };
}
