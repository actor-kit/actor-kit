/**
 * setup() — typed helpers for what an actor declares up front (ADR-017).
 *
 *   const auction = setup({ events: { BidPlaced: z.object({ bidder: z.string(), amount: z.number() }) } });
 *   defineActor("auction", {
 *     events: auction.events,
 *     messages: {
 *       BID: auction.message(z.object({ amount: z.number() }), (s: S, { amount }, ctx) => {
 *         ctx.emit("BidPlaced", { bidder: ctx.caller, amount }); // typed by the declared events
 *         return s;
 *       }),
 *     },
 *   });
 *
 * A `message()` handler defined inline cannot see the actor's `events` (TypeScript does not infer
 * a nested generic call from its siblings), so the typed emit comes from helpers bound to the
 * declarations, like XState's `setup()`. At runtime every emit is checked against `events`.
 */

import type { GuardContext, MessageContext, MessageDef, TimerContext, TimerDef } from "@actor-kit/core";
import type { z } from "zod";
import { message } from "./message";
import { timer } from "./timer";

export type EventSchemas = Record<string, z.ZodType>;

/** Payload type of each declared event. */
export type EventPayloads<T extends EventSchemas> = { [K in keyof T]: z.output<T[K]> };

/** emit() typed by an actor's declared events. */
export type TypedEmit<E> = <K extends keyof E & string>(name: K, payload: E[K]) => void;

export type EmittingMessageContext<TEnv, E> = Omit<MessageContext<TEnv>, "emit"> & { readonly emit: TypedEmit<E> };
export type EmittingTimerContext<TEnv, E> = Omit<TimerContext<TEnv>, "emit"> & { readonly emit: TypedEmit<E> };

type Handler<S, P, Ctx> = (state: S, payload: P, ctx: Ctx) => S;

export interface Setup<T extends EventSchemas> {
  /** The declared events, for the actor's `events`. */
  readonly events: T;
  message<P, S, TEnv = unknown>(
    schema: z.ZodType<P>,
    handler:
      | Handler<S, P, EmittingMessageContext<TEnv, EventPayloads<T>>>
      | {
          guard: (state: S, payload: P, ctx: GuardContext<TEnv>) => boolean;
          handler: Handler<S, P, EmittingMessageContext<TEnv, EventPayloads<T>>>;
        },
  ): MessageDef<S, P, TEnv>;
  timer<P, S, TEnv = unknown>(
    schema: z.ZodType<P>,
    handler: Handler<S, P, EmittingTimerContext<TEnv, EventPayloads<T>>>,
  ): TimerDef<S, P, TEnv>;
}

/** Bind a handler to a typed emit over the runtime's (checked) one. */
function typed<S, P, Ctx extends { readonly emit: (name: string, payload: unknown) => void }, E>(
  handler: Handler<S, P, Omit<Ctx, "emit"> & { readonly emit: TypedEmit<E> }>,
): Handler<S, P, Ctx> {
  return (state, payload, ctx) => handler(state, payload, { ...ctx, emit: (name, value) => ctx.emit(name, value) });
}

export function setup<const T extends EventSchemas>(declarations: { events: T }): Setup<T> {
  return {
    events: declarations.events,
    message(schema, handler) {
      if (typeof handler === "function") return message(schema, typed(handler));
      return message(schema, { guard: handler.guard, handler: typed(handler.handler) });
    },
    timer(schema, handler) {
      return timer(schema, typed(handler));
    },
  };
}
