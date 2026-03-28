/**
 * Message router — validates and dispatches messages to handlers.
 *
 * Flow:
 * 1. Look up message handler for the role
 * 2. Extract payload (strip `type` field)
 * 3. Validate payload with Zod schema (safeParse)
 * 4. Evaluate guard if present
 * 5. Call handler with (state, parsedPayload, ctx)
 */

import type { z } from "zod";
import type { MessageContext } from "../core/message";

// --- Route result ---

export type RouteResult<TState> =
  | { ok: true; state: TState; emissions: unknown[] }
  | { ok: false; error: "message_not_found" | "validation_failed" | "guard_failed"; detail?: string };

// --- Minimal shape for the router ---
// The router only needs schema + handler + guard. It doesn't care about the payload
// generic because Zod validates at runtime. We extract these fields structurally.

// Uses a method signature for bivariance — allows MessageHandler<ConcreteState, ConcretePayload>
// to be assignable without contravariance issues on the parameters. This is safe because
// Zod validates the payload at runtime before the handler is called.
interface RoutableMessage<TState> {
  readonly schema: z.ZodType;
  // Method signature (bivariant in --strict) instead of property signature (contravariant)
  handler(state: TState, payload: unknown, ctx: MessageContext): TState;
  guard?(state: TState, payload: unknown, ctx: MessageContext): boolean;
}

// --- Router ---

export function routeMessage<TState>(
  roleMessages: Record<string, Record<string, RoutableMessage<TState>>>,
  role: string,
  state: TState,
  event: { type: string; [key: string]: unknown },
  ctxBase: Omit<MessageContext, "role">,
): RouteResult<TState> {
  // 1. Look up messages for this role
  const messagesForRole = roleMessages[role];
  if (messagesForRole === undefined) {
    return { ok: false, error: "message_not_found" };
  }

  // 2. Look up handler for this message type
  const messageDef = messagesForRole[event.type];
  if (messageDef === undefined) {
    return { ok: false, error: "message_not_found" };
  }

  // 3. Extract payload (strip 'type' field)
  const { type: _type, ...payload } = event;

  // 4. Validate payload with Zod
  const parseResult = messageDef.schema.safeParse(payload);
  if (!parseResult.success) {
    return {
      ok: false,
      error: "validation_failed",
      detail: parseResult.error.message,
    };
  }

  // 5. Build full context (before guard so guards get ctx)
  const ctx: MessageContext = {
    ...ctxBase,
    role,
  };

  // 6. Evaluate guard with (state, payload, ctx)
  if (messageDef.guard !== undefined && !messageDef.guard(state, parseResult.data, ctx)) {
    return { ok: false, error: "guard_failed" };
  }

  // 7. Call handler — payload is Zod-validated, handler is correctly typed at definition site
  const nextState = messageDef.handler(state, parseResult.data, ctx);

  // Runtime guard: reject async handlers that slip past the type system (JS consumers, structural typing)
  if (nextState instanceof Promise) {
    throw new Error(
      `Message handler for "${event.type}" returned a Promise. Handlers must be synchronous — use emit() for async side effects.`,
    );
  }

  return { ok: true, state: nextState, emissions: [] };
}
