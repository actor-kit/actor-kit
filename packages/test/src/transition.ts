import type { ActorLogic, Caller, BaseEnv } from "@actor-kit/core";

/**
 * Mock env for pure tests.
 */
const mockEnv = new Proxy(
  { ACTOR_KIT_SECRET: "test-secret" } as BaseEnv,
  {
    get: (target, prop) =>
      prop in target
        ? target[prop as keyof typeof target]
        : undefined,
  }
);

type TransitionOptions<TState, TEvent extends { type: string }, TEnv extends BaseEnv, TInput> = {
  /** Starting state. If omitted, creates from initial state. */
  state?: TState;
  /** The event to apply. */
  event: TEvent;
  /** The caller sending this event. */
  caller: Caller;
  /** Custom input (used when no starting state is provided). */
  input?: TInput;
  /** Custom env (defaults to mock env with test-secret). */
  env?: TEnv;
};

type TransitionResult<TState, TView> = {
  /** The full internal state — pass to the next transition() call to chain. */
  state: TState;
  /** The caller-scoped view. */
  view: TView;
};

/**
 * Pure transition function for testing actor logic.
 *
 * Applies an event to an ActorLogic and returns the next state + view.
 * No DO, no WebSocket, no storage required.
 *
 * ```ts
 * const result = transition(counterLogic, {
 *   event: { type: 'INCREMENT' },
 *   caller: { type: 'client', id: 'user-1' },
 * });
 * expect(result.view.count).toBe(1);
 * ```
 */
export function transition<
  TState,
  TEvent extends { type: string },
  TView,
  TEnv extends BaseEnv,
  TInput,
>(
  logic: ActorLogic<TState, TEvent, TView, TEnv, TInput>,
  options: TransitionOptions<TState, TEvent, TEnv, TInput>
): TransitionResult<TState, TView> {
  const { state: existingState, event, caller, input, env } = options;
  const resolvedEnv = (env ?? mockEnv) as TEnv;

  // Get or create initial state
  const currentState = existingState ?? logic.create(input as TInput);

  // Apply transition with augmented event
  const augmentedEvent = {
    ...event,
    caller,
    env: resolvedEnv,
  } as TEvent & { caller: Caller; env: TEnv };

  const nextState = logic.transition(currentState, augmentedEvent);
  const view = logic.getView(nextState, caller);

  return { state: nextState, view };
}
