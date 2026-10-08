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
 *
 * Every callback receives a trailing `ctx` with now()/id()/random() (ADR-013).
 */

import type { DeterministicContext } from "@actor-kit/core";
import type { RetryOption } from "./runtime/retry";

/** Link declaration — returned by link(contract, handlers). */
export interface LinkDef<TContract, TView, TState = unknown> {
  readonly contract: TContract;
  readonly onUpdate: (state: TState, view: TView, id: string | undefined, ctx: DeterministicContext) => TState;
  readonly onError:
    | ((
        state: TState,
        error: { message: string; code: string },
        id: string | undefined,
        ctx: DeterministicContext,
      ) => TState)
    | undefined;
  readonly onUnlink: ((state: TState, id: string | undefined, ctx: DeterministicContext) => TState) | undefined;
  /** Tries and backoff for messages forwarded through this link (same shape and defaults as services). */
  readonly retry: RetryOption;
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
    onUpdate: (state: TState, view: TView, id: string | undefined, ctx: DeterministicContext) => TState;
    onError?: (
      state: TState,
      error: { message: string; code: string },
      id: string | undefined,
      ctx: DeterministicContext,
    ) => TState;
    onUnlink?: (state: TState, id: string | undefined, ctx: DeterministicContext) => TState;
    /** Tries and backoff for ctx.forward() through this link. Default: 3 tries, 1s then 5s apart. */
    retry?: RetryOption;
  },
): LinkDef<TContract, TView, TState> {
  return {
    contract,
    onUpdate: handlers.onUpdate,
    onError: handlers.onError,
    onUnlink: handlers.onUnlink,
    retry: handlers.retry,
  };
}
