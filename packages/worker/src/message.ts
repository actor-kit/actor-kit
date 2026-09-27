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

import type { GuardContext, MessageContext, MessageDef } from "@actor-kit/core";
import type { z } from "zod";

// --- Message handler types ---

type MessageHandler<TState, TPayload, TEnv = unknown> = (
  state: TState,
  payload: TPayload,
  ctx: MessageContext<TEnv>,
) => TState;

type GuardFn<TState, TPayload = unknown, TEnv = unknown> = (
  state: TState,
  payload: TPayload,
  ctx: GuardContext<TEnv>,
) => boolean;

interface GuardedHandler<TState, TPayload, TEnv = unknown> {
  guard: GuardFn<TState, TPayload, TEnv>;
  handler: MessageHandler<TState, TPayload, TEnv>;
}

// --- message() function ---

// Generic over the payload (the schema's output), not the schema type — the
// payload is inferred from the schema and flows into the handler and MessageDef.

// Overload 1: bare handler (no guard)
export function message<TPayload, TState, TEnv = unknown>(
  zodSchema: z.ZodType<TPayload>,
  handler: MessageHandler<TState, TPayload, TEnv>,
): MessageDef<TState, TPayload, TEnv>;

// Overload 2: guarded handler
export function message<TPayload, TState, TEnv = unknown>(
  zodSchema: z.ZodType<TPayload>,
  config: GuardedHandler<TState, TPayload, TEnv>,
): MessageDef<TState, TPayload, TEnv>;

// Implementation
export function message<TPayload, TState, TEnv = unknown>(
  zodSchema: z.ZodType<TPayload>,
  handlerOrConfig: MessageHandler<TState, TPayload, TEnv> | GuardedHandler<TState, TPayload, TEnv>,
): MessageDef<TState, TPayload, TEnv> {
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
