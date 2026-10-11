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
import type { TypedEmit } from "./setup";

/**
 * What link callbacks get as ctx: now/id/random and `emit` (ADR-018 F), typed by the actor's events when
 * the link comes from `kit.link()` (a standalone `link()` has no events to emit).
 */
export type LinkContext<E = Record<never, never>> = DeterministicContext & { readonly emit: TypedEmit<E> };

/** Link declaration — returned by link(contract, handlers). */
export interface LinkDef<TContract, TView, TState = unknown, E = Record<never, never>> {
  readonly contract: TContract;
  readonly onUpdate: (state: TState, view: TView, id: string | undefined, ctx: LinkContext<E>) => TState;
  readonly onError:
    | ((state: TState, error: { message: string; code: string }, id: string | undefined, ctx: LinkContext<E>) => TState)
    | undefined;
  readonly onUnlink: ((state: TState, id: string | undefined, ctx: LinkContext<E>) => TState) | undefined;
  /** Tries and backoff for messages forwarded through this link (same shape and defaults as services). */
  readonly retry: RetryOption;
  /** Time limit per forward try, in ms (ADR-016 §3, default 30 000). */
  readonly timeoutMs: number | undefined;
}

/** Link error codes. */
export type LinkErrorCode = "not_found" | "unauthorized" | "unreachable";

/** A link's handlers, with ctx.emit typed by `E`. */
export interface LinkHandlers<TState, TView, E> {
  onUpdate: (state: TState, view: TView, id: string | undefined, ctx: LinkContext<E>) => TState;
  onError?: (
    state: TState,
    error: { message: string; code: string },
    id: string | undefined,
    ctx: LinkContext<E>,
  ) => TState;
  onUnlink?: (state: TState, id: string | undefined, ctx: LinkContext<E>) => TState;
  /** Tries and backoff for ctx.forward() through this link. Default: 3 tries, 1s then 5s apart. */
  retry?: RetryOption;
  /** Time limit per forward try, in ms. Default 30 000; a try that runs out is a Timeout (retried). */
  timeoutMs?: number;
}

/** Create a link declaration. */
export function link<
  TContract extends { readonly name: string; readonly def: Record<string, unknown> },
  TState = unknown,
  TView = unknown,
  E = Record<never, never>,
>(
  contract: TContract,
  handlers: {
    onUpdate: (state: TState, view: TView, id: string | undefined, ctx: LinkContext<E>) => TState;
    onError?: (
      state: TState,
      error: { message: string; code: string },
      id: string | undefined,
      ctx: LinkContext<E>,
    ) => TState;
    onUnlink?: (state: TState, id: string | undefined, ctx: LinkContext<E>) => TState;
    /** Tries and backoff for ctx.forward() through this link. Default: 3 tries, 1s then 5s apart. */
    retry?: RetryOption;
    /** Time limit per forward try, in ms. Default 30 000; a try that runs out is a Timeout (retried). */
    timeoutMs?: number;
  },
): LinkDef<TContract, TView, TState, E> {
  return {
    contract,
    onUpdate: handlers.onUpdate,
    onError: handlers.onError,
    onUnlink: handlers.onUnlink,
    retry: handlers.retry,
    timeoutMs: handlers.timeoutMs,
  };
}
