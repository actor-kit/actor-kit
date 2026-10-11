/** Types derived from a contract (defineActor): its state and its spawn input. */

/** A state's local, as `kit.in(phase).state()` carries it (phantom `~local`); unknown otherwise. */
type PhaseLocal<D> = D extends { readonly "~local"?: infer L } ? L : unknown;

/** The persisted state of an actor with states (ADR-017 §1), a union narrowed by `phase`. */
type Phased<SS, S> = {
  [P in keyof SS & string]: { shared: S; phase: P; local: PhaseLocal<SS[P]>; stateTimers: string[] };
}[keyof SS & string];

/**
 * The state type: what the contract's init() returns (awaited), or for an actor with `states` the
 * persisted `{ shared, phase, local, stateTimers }` (ADR-018 D).
 */
export type ContractState<T> = T extends { def: { init: (...args: never[]) => infer S } }
  ? T extends { def: { states: infer SS } }
    ? Phased<SS, Awaited<S>>
    : Awaited<S>
  : unknown;

/** The spawn input: the input schema's input type (what callers pass before parsing). */
export type ContractInput<T> = T extends { def: { input: { _input: infer I } } } ? I : unknown;
