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

// --- Effect types for emit() and request() ---

export type Effect =
  | { queue: string; body: unknown }
  | { fetch: string; method?: string; body?: unknown; headers?: Record<string, string> }
  | { actor: string; id: string; message: string; payload: unknown };

export type RequestConfig = Effect & { onDone: string; onError: string };

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

// --- Message handler types ---

type MessageHandler<TState, TPayload, TEnv = unknown> = (
  state: TState,
  payload: TPayload,
  ctx: MessageContext<TEnv>,
) => TState | Promise<TState>;

type GuardFn<TState> = (state: TState) => boolean;

interface GuardedHandler<TState, TPayload, TEnv = unknown> {
  guard: GuardFn<TState>;
  handler: MessageHandler<TState, TPayload, TEnv>;
}

// --- MessageDef ---

export interface MessageDef<TState = unknown, TPayload = unknown, TEnv = unknown> {
  readonly schema: z.ZodType<TPayload>;
  readonly handler: MessageHandler<TState, TPayload, TEnv>;
  readonly guard: GuardFn<TState> | undefined;
}

// --- message() function ---

// Overload 1: bare handler (no guard)
export function message<
  TSchema extends z.ZodType,
  TState,
  TEnv = unknown,
>(
  zodSchema: TSchema,
  handler: MessageHandler<TState, z.infer<TSchema>, TEnv>,
): MessageDef<TState, z.infer<TSchema>, TEnv>;

// Overload 2: guarded handler
export function message<
  TSchema extends z.ZodType,
  TState,
  TEnv = unknown,
>(
  zodSchema: TSchema,
  config: GuardedHandler<TState, z.infer<TSchema>, TEnv>,
): MessageDef<TState, z.infer<TSchema>, TEnv>;

// Implementation
export function message<
  TSchema extends z.ZodType,
  TState,
  TEnv = unknown,
>(
  zodSchema: TSchema,
  handlerOrConfig:
    | MessageHandler<TState, z.infer<TSchema>, TEnv>
    | GuardedHandler<TState, z.infer<TSchema>, TEnv>,
): MessageDef<TState, z.infer<TSchema>, TEnv> {
  if (typeof handlerOrConfig === "function") {
    return {
      schema: zodSchema,
      handler: handlerOrConfig,
      guard: undefined,
    };
  }
  return {
    schema: zodSchema,
    handler: handlerOrConfig.handler,
    guard: handlerOrConfig.guard,
  };
}
