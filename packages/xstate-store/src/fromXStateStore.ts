/**
 * @xstate/store adapter for actor-kit.
 *
 * Wraps an @xstate/store definition in the ActorLogic interface.
 * Events are augmented with caller/env before being sent to the store.
 */
import { createStore } from "@xstate/store";
import type { ActorLogic, Caller, BaseEnv } from "@actor-kit/core";

type StoreDefinition<TContext extends Record<string, unknown>> = {
  context: TContext | ((input: Record<string, unknown>) => TContext);
  on: Record<string, (context: TContext, event: { caller: Caller; env: BaseEnv; [key: string]: unknown }) => TContext>;
};

type FromXStateStoreOptions<TContext, TView> = {
  getView: (state: TContext, caller: Caller) => TView;
};

/**
 * Creates an ActorLogic from an @xstate/store definition.
 *
 * The store's transitions receive events augmented with `caller` and `env`.
 * Access them via `event.caller` in your transition functions.
 *
 * @example
 * ```ts
 * const logic = fromXStateStore({
 *   context: { count: 0 },
 *   on: {
 *     inc: (ctx, event: { caller: Caller }) => ({
 *       ...ctx,
 *       count: ctx.count + 1,
 *       lastUpdatedBy: event.caller.id,
 *     }),
 *   },
 * }, {
 *   getView: (state, caller) => ({ count: state.count }),
 * });
 * ```
 */
export function fromXStateStore<
  TContext extends Record<string, unknown>,
  TView,
  TEnv extends BaseEnv = BaseEnv,
>(
  definition: StoreDefinition<TContext>,
  options: FromXStateStoreOptions<TContext, TView>
): ActorLogic<TContext, { type: string; [key: string]: unknown }, TView, TEnv, Record<string, unknown>> {
  return {
    create(input: Record<string, unknown>, _ctx: { id: string; caller: import("@actor-kit/core").Caller; env: TEnv }): TContext {
      if (typeof definition.context === "function") {
        return definition.context(input);
      }
      return { ...definition.context };
    },

    transition(
      state: TContext,
      event: { type: string; caller: Caller; env: TEnv; [key: string]: unknown }
    ): TContext {
      const handler = definition.on[event.type];
      if (!handler) return state;
      return handler(state, event);
    },

    getView(state: TContext, caller: Caller): TView {
      return options.getView(state, caller);
    },

    serialize(state: TContext): unknown {
      return state;
    },

    restore(serialized: unknown): TContext {
      return serialized as TContext;
    },
  };
}
