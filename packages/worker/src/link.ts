/**
 * link() — declaration helper for actor-to-actor state sync.
 *
 * Declares a link to another actor type with handlers for updates, errors, and cleanup.
 * Used in the `links` block of defineActor().
 *
 * Usage:
 *   links: {
 *     profile: link(ProfileContract, {
 *       onUpdate: (state, view) => ({ ...state, profile: view }),
 *       onError: (state, error) => ({ ...state, profileError: error.message }),
 *     }),
 *   }
 */

/** Link declaration — returned by link(contract, handlers). */
export interface LinkDef<TContract, TView, TState = unknown> {
  readonly contract: TContract;
  readonly onUpdate: (state: TState, view: TView, id?: string) => TState;
  readonly onError: ((state: TState, error: { message: string; code: string }, id?: string) => TState) | undefined;
  readonly onUnlink: ((state: TState, id?: string) => TState) | undefined;
}

/** Link error codes. */
export type LinkErrorCode = "not_found" | "unauthorized" | "unreachable";

/** Create a link declaration. */
export function link<
  TContract extends { readonly name: string; readonly def: Record<string, unknown> },
  TState = unknown,
  TView = unknown,
>(
  contract: TContract,
  handlers: {
    onUpdate: (state: TState, view: TView, id?: string) => TState;
    onError?: (state: TState, error: { message: string; code: string }, id?: string) => TState;
    onUnlink?: (state: TState, id?: string) => TState;
  },
): LinkDef<TContract, TView, TState> {
  return {
    contract,
    onUpdate: handlers.onUpdate,
    onError: handlers.onError,
    onUnlink: handlers.onUnlink,
  };
}
