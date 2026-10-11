/** Types derived from a contract (defineActor): its state and its spawn input. */

/** A state's local, as `kit.in(path).state()` carries it (phantom `~local`); unknown otherwise. */
type PhaseLocal<D> = D extends { readonly "~local"?: infer L } ? L : unknown;

/** A state's child states, as its definition holds them (never for a leaf). */
type ChildDefs<D> = D extends { readonly states?: infer C }
  ? [C] extends [undefined]
    ? never
    : NonNullable<C>
  : never;

type Deeper<D extends unknown[]> = [...D, unknown];

/** The leaf paths of a definition's state tree (ADR-019 A): what the persisted phase can be. */
type LeafPaths<SS, D extends unknown[] = []> = D["length"] extends 6
  ? never
  : {
      [K in keyof SS & string]: [ChildDefs<SS[K]>] extends [never]
        ? readonly [K]
        : readonly [K, ...LeafPaths<ChildDefs<SS[K]>, Deeper<D>>];
    }[keyof SS & string];

/** The local of each level along a path, root first. */
type LocalsAlong<SS, P> = P extends readonly [infer H, ...infer R]
  ? H extends keyof SS
    ? [PhaseLocal<SS[H]>, ...LocalsAlong<ChildDefs<SS[H]>, R>]
    : []
  : [];

/** The persisted state of an actor with states (ADR-017 §1, ADR-019 A), a union over its leaf paths. */
type Phased<SS, S> =
  LeafPaths<SS> extends infer P
    ? P extends readonly string[]
      ? { shared: S; phase: P; locals: LocalsAlong<SS, P>; stateTimers: string[][] }
      : never
    : never;

/**
 * The state type: what the contract's init() returns (awaited), or for an actor with `states` the
 * persisted `{ shared, phase, locals, stateTimers }` (ADR-018 D, ADR-019 A).
 */
export type ContractState<T> = T extends { def: { init: (...args: never[]) => infer S } }
  ? T extends { def: { states: infer SS } }
    ? Phased<SS, Awaited<S>>
    : Awaited<S>
  : unknown;

/** The spawn input: the input schema's input type (what callers pass before parsing). */
export type ContractInput<T> = T extends { def: { input: { _input: infer I } } } ? I : unknown;
