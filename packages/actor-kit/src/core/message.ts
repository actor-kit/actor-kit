/**
 * message() helper — pairs a Zod schema with a handler function.
 *
 * Every message handler must be wrapped in message() to provide runtime
 * payload validation at the boundary.
 *
 * Usage:
 *   // Simple handler
 *   const increment = message(
 *     z.object({ amount: z.number() }),
 *     (state, { amount }, ctx) => ({ ...state, count: state.count + amount }),
 *   );
 *
 *   // With guard
 *   const addItem = message(
 *     z.object({ text: z.string() }),
 *     {
 *       guard: (state) => state.items.length < 10,
 *       handler: (state, { text }, ctx) => ({ ...state, items: [...state.items, text] }),
 *     },
 *   );
 */

import type { z } from "zod";
import type { CallbackDef } from "./callback";

// --- Effect types for emit() and request() ---

export type Effect =
  | { queue: string; body: unknown }
  | { fetch: string; method?: string; body?: unknown; headers?: Record<string, string> }
  | { actor: string; id: string; message: string; payload: unknown };

/** User-facing request config — accepts CallbackDef objects + typed meta. */
export type RequestConfig = Effect & {
  onDone: CallbackDef<string, unknown, unknown> | string;
  onError: CallbackDef<string, unknown, unknown> | string;
  meta?: unknown;
};

/** Normalized request config — keys extracted from CallbackDefs, stored in outbox. */
export interface NormalizedRequestConfig {
  effect: Effect;
  onDone: string;
  onError: string;
  meta?: unknown;
}

/** Normalize a RequestConfig — extract .key from CallbackDefs, separate effect from callbacks. */
export function normalizeRequest(config: RequestConfig): NormalizedRequestConfig {
  const { onDone, onError, meta, ...effect } = config;
  return {
    effect: effect as Effect,
    onDone: typeof onDone === "string" ? onDone : onDone.key,
    onError: typeof onError === "string" ? onError : onError.key,
    meta,
  };
}

export type EmitFn = (effect: Effect) => void;
export type RequestFn = (config: RequestConfig) => void;

// --- Message context ---

export interface MessageContext<TEnv = unknown> {
  readonly caller: string;
  readonly callerType: "user" | "service";
  readonly role: string;
  readonly env: TEnv;
  readonly emit: EmitFn;
  readonly request: RequestFn;
}

// --- Guard context ---

/** Context available to guards — same as MessageContext but without request (guards are pure predicates). */
export interface GuardContext<TEnv = unknown> {
  readonly role: string;
  readonly caller: string;
  readonly callerType: "user" | "service";
  readonly env: TEnv;
  readonly emit: EmitFn;
}

// --- Message handler types ---

type MessageHandler<TState, TPayload, TEnv = unknown> = (
  state: TState,
  payload: TPayload,
  ctx: MessageContext<TEnv>,
) => TState | Promise<TState>;

type GuardFn<TState, TPayload = unknown, TEnv = unknown> = (
  state: TState,
  payload: TPayload,
  ctx: GuardContext<TEnv>,
) => boolean;

interface GuardedHandler<TState, TPayload, TEnv = unknown> {
  guard: GuardFn<TState, TPayload, TEnv>;
  handler: MessageHandler<TState, TPayload, TEnv>;
}

// --- MessageDef ---

export interface MessageDef<TState = unknown, TPayload = unknown, TEnv = unknown> {
  readonly schema: z.ZodType<TPayload>;
  readonly handler: MessageHandler<TState, TPayload, TEnv>;
  readonly guard?: GuardFn<TState, TPayload, TEnv>;
}

// --- message() function ---

// Overload 1: bare handler (no guard)
export function message<TSchema extends z.ZodType, TState, TEnv = unknown>(
  zodSchema: TSchema,
  handler: MessageHandler<TState, z.infer<TSchema>, TEnv>,
): MessageDef<TState, z.infer<TSchema>, TEnv>;

// Overload 2: guarded handler
export function message<TSchema extends z.ZodType, TState, TEnv = unknown>(
  zodSchema: TSchema,
  config: GuardedHandler<TState, z.infer<TSchema>, TEnv>,
): MessageDef<TState, z.infer<TSchema>, TEnv>;

// Implementation
export function message<TSchema extends z.ZodType, TState, TEnv = unknown>(
  zodSchema: TSchema,
  handlerOrConfig: MessageHandler<TState, z.infer<TSchema>, TEnv> | GuardedHandler<TState, z.infer<TSchema>, TEnv>,
): MessageDef<TState, z.infer<TSchema>, TEnv> {
  if (typeof handlerOrConfig === "function") {
    return {
      schema: zodSchema,
      handler: handlerOrConfig,
    };
  }
  return {
    schema: zodSchema,
    handler: handlerOrConfig.handler,
    guard: handlerOrConfig.guard,
  };
}
