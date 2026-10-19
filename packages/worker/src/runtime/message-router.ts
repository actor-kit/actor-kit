/**
 * Message router — validates and dispatches messages to handlers.
 *
 * Flow: admitMessage() (look up the message for the role, strip `type`, parse the payload with
 * Zod, run the guard), then call the handler with (state, parsedPayload, ctx). The Durable
 * Object admits and then runs the handler through the step core; testActor() uses this.
 */

import type { GuardContext, MessageContext, StandardSchema } from "@actor-kit/core";
import { ActorKitError } from "@actor-kit/core";
import { admitMessage } from "./step";

// --- Route result ---

export type RouteResult<TState> =
  | { ok: true; state: TState; payload: unknown }
  | { ok: false; error: "message_not_found" | "validation_failed" | "guard_failed"; detail?: string }
  | { ok: false; error: "wrong_role"; roles: readonly string[] };

// --- Minimal shape for the router ---
// The router only needs schema + handler + guard. It doesn't care about the payload
// generic because Zod validates at runtime. We extract these fields structurally.

// Uses a method signature for bivariance — allows MessageHandler<ConcreteState, ConcretePayload>
// to be assignable without contravariance issues on the parameters. This is safe because
// Zod validates the payload at runtime before the handler is called.
interface RoutableMessage<TState> {
  readonly schema: StandardSchema;
  // Method signature (bivariant in --strict) instead of property signature (contravariant)
  handler(state: TState, payload: unknown, ctx: MessageContext): TState;
  guard?(state: TState, payload: unknown, ctx: GuardContext): boolean;
}

// --- Router ---

/** Admit the message (find it for the role, parse its payload, run its guard), then run its handler. */
export function routeMessage<TState>(
  roleMessages: Record<string, Record<string, RoutableMessage<TState>>>,
  role: string,
  state: TState,
  event: { type: string; [key: string]: unknown },
  ctxBase: Omit<MessageContext, "role">,
): RouteResult<TState> {
  const admission = admitMessage(roleMessages, role, state, event, {
    caller: ctxBase.caller,
    callerType: ctxBase.callerType,
    env: ctxBase.env,
  });
  if (!admission.ok) return admission;

  // Payload is Zod-validated; the handler is correctly typed at its definition site.
  const nextState = admission.message.handler(state, admission.payload, { ...ctxBase, role });

  // Runtime guard: reject async handlers that slip past the type system (JS consumers, structural typing)
  if (nextState instanceof Promise) {
    throw new ActorKitError(
      "async_handler",
      `Message handler for "${event.type}" returned a Promise. Handlers must be synchronous — use execute() for async side effects.`,
    );
  }

  return { ok: true, state: nextState, payload: admission.payload };
}
