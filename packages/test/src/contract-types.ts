/** Types derived from a contract (defineActor): its state and its spawn input. */

/** The state type: what the contract's init() returns (awaited). */
export type ContractState<T> = T extends { def: { init: (...args: never[]) => infer S } } ? Awaited<S> : unknown;

/** The spawn input: the input schema's input type (what callers pass before parsing). */
export type ContractInput<T> = T extends { def: { input: { _input: infer I } } } ? I : unknown;
