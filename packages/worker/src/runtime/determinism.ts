/**
 * Determinism guards (ADR-016 §5, ADR-018 E).
 *
 * While a handler runs guarded, the globals that read the clock or randomness are replaced: Date.now,
 * `new Date()` / `Date()` without arguments, performance.now, Math.random, crypto.randomUUID and
 * crypto.getRandomValues. Handlers use ctx.now(), ctx.random() and ctx.id(), which are recorded in the
 * journal. The globals are restored exactly (own property descriptors) when the handler returns or
 * throws. A service's fn is never guarded. An async init is guarded until its first await.
 *
 * - withDeterminismGuard (testActor, simulate, replayJournal, and actors with `determinism: "throw"`):
 *   the globals throw NondeterminismError.
 * - withDeterminismWarnings (the Workers runtime's default, `determinism: "warn"`): each call is reported
 *   and then answered by the real global, so production keeps running and the transition is flagged.
 *
 * Guards nest: the outermost one decides whether calls throw or are reported.
 */

import { ActorKitError } from "@actor-kit/core";

export class NondeterminismError extends ActorKitError {
  override name = "NondeterminismError";
  constructor(message: string) {
    super("nondeterminism", message);
  }
}

/** A global a handler called: what it was and what to use instead. */
export interface Violation {
  readonly what: string;
  readonly use: string;
}

/** Where calls go while guarded: null throws, a function hears about each call (warn). */
let reporter: ((violation: Violation) => void) | null = null;

/** A replaced global: throws, or reports the call and answers with the real `original`. */
function violation<A extends unknown[], R>(what: string, use: string, original: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    if (reporter === null) {
      throw new NondeterminismError(
        `${what} is not allowed in a handler: use ${use} (recorded in the journal, so replay reproduces it)`,
      );
    }
    reporter({ what, use });
    return original(...args);
  };
}

interface Saved {
  readonly target: object;
  readonly key: PropertyKey;
  readonly descriptor: PropertyDescriptor | undefined;
}

/** The real sources while guarded (whatever they were before, fake timers included), for ctx.now/id/random. */
let real: { now(): number; random(): number; randomUUID(): string } | null = null;
let depth = 0;
let saved: Saved[] = [];

/** The clock and randomness behind ctx.now(), ctx.random() and ctx.id(): never the guarded globals. */
export const realSources = {
  now: (): number => (real === null ? Date.now() : real.now()),
  random: (): number => (real === null ? Math.random() : real.random()),
  randomUUID: (): string => (real === null ? crypto.randomUUID() : real.randomUUID()),
};

function replace(target: object, key: PropertyKey, value: unknown): void {
  saved.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
  Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: false });
}

/** Date without the arguments-free forms: `new Date(x)`, Date.UTC, Date.parse still work. */
function guardedDate(OriginalDate: DateConstructor): DateConstructor {
  const construct = violation("new Date()", "ctx.now()", () => new OriginalDate());
  const call = violation("Date()", "ctx.now()", () => OriginalDate());
  const now = violation("Date.now()", "ctx.now()", () => OriginalDate.now());
  return new Proxy(OriginalDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) return construct();
      return Reflect.construct(target, args, newTarget);
    },
    apply: () => call(),
    get(target, key, receiver) {
      if (key === "now") return now;
      return Reflect.get(target, key, receiver);
    },
  });
}

function patch(): void {
  const now = Date.now.bind(Date);
  const random = Math.random.bind(Math);
  const randomUUID = crypto.randomUUID.bind(crypto);
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  const perfNow = performance.now.bind(performance);
  real = { now, random, randomUUID };
  replace(globalThis, "Date", guardedDate(Date));
  replace(performance, "now", violation("performance.now()", "ctx.now()", perfNow));
  replace(Math, "random", violation("Math.random()", "ctx.random()", random));
  replace(crypto, "randomUUID", violation("crypto.randomUUID()", "ctx.id()", randomUUID));
  replace(crypto, "getRandomValues", violation("crypto.getRandomValues()", "ctx.random()", getRandomValues));
}

function restore(): void {
  for (const { target, key, descriptor } of saved.reverse()) {
    if (descriptor === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, descriptor);
  }
  saved = [];
  real = null;
}

/** Run `handler` guarded; the outermost guard sets `report` (null: throw). Restored whatever happens. */
function guard<T>(report: ((violation: Violation) => void) | null, handler: () => T): T {
  if (depth === 0) {
    patch();
    reporter = report;
  }
  depth += 1;
  try {
    return handler();
  } finally {
    depth -= 1;
    if (depth === 0) {
      restore();
      reporter = null;
    }
  }
}

/** Run `handler` with the nondeterministic globals throwing; restore them afterwards, whatever happens. */
export function withDeterminismGuard<T>(handler: () => T): T {
  return guard(null, handler);
}

/**
 * Run `handler` with every call of a nondeterministic global reported to `report` and answered by the
 * real global (ADR-018 E, `determinism: "warn"`); restore them afterwards, whatever happens.
 */
export function withDeterminismWarnings<T>(report: (violation: Violation) => void, handler: () => T): T {
  return guard(report, handler);
}

export type DeterminismMode = "throw" | "warn" | "off";

/** An actor's `determinism` option, validated (default "warn"). */
export function resolveDeterminism(option: unknown): DeterminismMode {
  if (option === undefined) return "warn";
  if (option === "throw" || option === "warn" || option === "off") return option;
  throw new ActorKitError(
    "invalid_determinism_option",
    `Invalid determinism option ${JSON.stringify(option)}: use "throw", "warn" or "off" (default "warn").`,
  );
}

/** The guard a transition runs under for a mode, and the calls it reported (warn mode only). */
export interface DeterminismWatch {
  readonly guard: (<T>(handler: () => T) => T) | undefined;
  readonly violations: readonly Violation[];
}

/** A fresh watch for one transition: "off" patches nothing, "throw" throws, "warn" reports and goes on. */
export function determinismWatch(mode: DeterminismMode): DeterminismWatch {
  if (mode === "off") return { guard: undefined, violations: [] };
  if (mode === "throw") return { guard: withDeterminismGuard, violations: [] };
  const violations: Violation[] = [];
  return { guard: (handler) => withDeterminismWarnings((v) => violations.push(v), handler), violations };
}

/** The journal draft, flagged `nondeterministic` when its handlers called a nondeterministic global. */
export function flagNondeterministic<D extends object>(
  draft: D,
  violations: readonly Violation[],
): D | (D & { nondeterministic: true }) {
  return violations.length === 0 ? draft : { ...draft, nondeterministic: true };
}

export interface NondeterministicEvent {
  readonly event: "actor_kit.handler.nondeterministic";
  readonly actorType: string;
  readonly actorId: string;
  readonly causeType: string;
  readonly name: string | null;
  /** Each global called, once, in call order. */
  readonly calls: readonly string[];
  /** What to use instead, for each of `calls`. */
  readonly use: readonly string[];
}

/** The structured line logged for a transition whose handlers read the clock or randomness directly. */
export function nondeterministicEvent(
  actorType: string,
  actorId: string,
  draft: { readonly causeType: string; readonly name: string | null },
  violations: readonly Violation[],
): NondeterministicEvent {
  const distinct = violations.filter((v, i) => violations.findIndex((w) => w.what === v.what) === i);
  return {
    event: "actor_kit.handler.nondeterministic",
    actorType,
    actorId,
    causeType: draft.causeType,
    name: draft.name,
    calls: distinct.map((v) => v.what),
    use: distinct.map((v) => v.use),
  };
}
