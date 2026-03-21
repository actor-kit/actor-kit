/**
 * Redux adapter for actor-kit.
 *
 * Wraps a Redux-style reducer in the ActorLogic interface.
 * Actions are augmented with caller/env before reaching the reducer.
 */
import type { ActorLogic, Caller, BaseEnv } from "@actor-kit/core";

type ReduxReducer<TState, TAction extends { type: string }> = (
  state: TState | undefined,
  action: TAction
) => TState;

type FromReduxOptions<TState, TView, TInput> = {
  /** Create initial state from input. */
  create: (input: TInput, ctx: { id: string; caller: Caller; env: BaseEnv }) => TState;
  /** Map state to a caller-scoped view. */
  getView: (state: TState, caller: Caller) => TView;
  /** Serialize state for persistence. Defaults to identity. */
  serialize?: (state: TState) => unknown;
  /** Restore state from serialized form. Defaults to cast. */
  restore?: (serialized: unknown) => TState;
  /** Version number for migration support. */
  version?: number;
  /** Migrate from a previous version. */
  migrate?: (serialized: unknown, version?: number) => TState;
};

/**
 * Creates an ActorLogic from a Redux-style reducer.
 *
 * The reducer receives actions augmented with `caller` and `env`.
 * Access them via `action.caller` in your reducer.
 *
 * @example
 * ```ts
 * const logic = fromRedux(counterReducer, {
 *   create: (input) => ({ count: input.initialCount ?? 0 }),
 *   getView: (state, caller) => ({ count: state.count }),
 * });
 * ```
 */
export function fromRedux<
  TState,
  TAction extends { type: string },
  TView,
  TEnv extends BaseEnv = BaseEnv,
  TInput = Record<string, unknown>,
>(
  reducer: ReduxReducer<TState, TAction & { caller: Caller; env: TEnv }>,
  options: FromReduxOptions<TState, TView, TInput>
): ActorLogic<TState, TAction, TView, TEnv, TInput> {
  return {
    create: (input: TInput, ctx: { id: string; caller: Caller; env: TEnv }) => options.create(input, ctx),

    transition(
      state: TState,
      event: TAction & { caller: Caller; env: TEnv }
    ): TState {
      return reducer(state, event);
    },

    getView: options.getView,

    serialize: options.serialize ?? ((state) => JSON.parse(JSON.stringify(state))),
    restore: options.restore ?? ((serialized) => serialized as TState),
    version: options.version,
    migrate: options.migrate,
  };
}
