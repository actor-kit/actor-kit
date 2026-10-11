import { ActorKitError } from "@actor-kit/core";
/**
 * Determinism guards for the test harness (ADR-016 §5).
 *
 * While a handler runs under testActor(), simulate() or replayJournal(), the globals that read the clock
 * or randomness throw NondeterminismError: Date.now, `new Date()` / `Date()` without arguments,
 * performance.now, Math.random, crypto.randomUUID and crypto.getRandomValues. Handlers use ctx.now(),
 * ctx.random() and ctx.id(), which are recorded in the journal. The globals are restored exactly (own
 * property descriptors) when the handler returns or throws. A service's fn is never guarded, and the
 * Workers runtime never patches globals: only the harness calls withDeterminismGuard.
 *
 * An async init is guarded until its first await.
 */

export class NondeterminismError extends ActorKitError {
  override name = "NondeterminismError";
  constructor(message: string) {
    super("nondeterminism", message);
  }
}

const refuse = (what: string, use: string) => (): never => {
  throw new NondeterminismError(
    `${what} is not allowed in a handler: use ${use} (recorded in the journal, so replay reproduces it)`,
  );
};

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
  return new Proxy(OriginalDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) refuse("new Date()", "ctx.now()")();
      return Reflect.construct(target, args, newTarget);
    },
    apply: refuse("Date()", "ctx.now()"),
    get(target, key, receiver) {
      if (key === "now") return refuse("Date.now()", "ctx.now()");
      return Reflect.get(target, key, receiver);
    },
  });
}

function patch(): void {
  const now = Date.now.bind(Date);
  const random = Math.random.bind(Math);
  const randomUUID = crypto.randomUUID.bind(crypto);
  real = { now, random, randomUUID };
  replace(globalThis, "Date", guardedDate(Date));
  replace(performance, "now", refuse("performance.now()", "ctx.now()"));
  replace(Math, "random", refuse("Math.random()", "ctx.random()"));
  replace(crypto, "randomUUID", refuse("crypto.randomUUID()", "ctx.id()"));
  replace(crypto, "getRandomValues", refuse("crypto.getRandomValues()", "ctx.random()"));
}

function restore(): void {
  for (const { target, key, descriptor } of saved.reverse()) {
    if (descriptor === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, descriptor);
  }
  saved = [];
  real = null;
}

/** Run `handler` with the nondeterministic globals throwing; restore them afterwards, whatever happens. */
export function withDeterminismGuard<T>(handler: () => T): T {
  if (depth === 0) patch();
  depth += 1;
  try {
    return handler();
  } finally {
    depth -= 1;
    if (depth === 0) restore();
  }
}
