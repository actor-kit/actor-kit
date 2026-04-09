/**
 * actorContext() — create a typed React context from a contract or ActorClientFactory.
 *
 * Usage (v3 — contract-derived):
 *   import { defineActor, message } from "@actor-kit/worker";
 *   import { actorContext } from "@actor-kit/react";
 *
 *   const Counter = defineActor("counter", { init, messages, views });
 *   const CounterCtx = actorContext(Counter);
 *
 * Usage (type-only — no runtime import of contract):
 *   import type { MyContract } from "./my-actor";
 *   import { actorContext } from "@actor-kit/react";
 *
 *   const MyCtx = actorContext<typeof MyContract>();
 *
 * Usage (legacy — factory-derived):
 *   import { actorClient } from "@actor-kit/client";
 *   import { actorContext } from "@actor-kit/react";
 *
 *   const CounterClient = actorClient(CounterView).messages<CounterMessage>();
 *   const CounterCtx = actorContext<typeof CounterClient>();
 */

import type { ActorClientFactory, ContractMessages, InferMessage, InferView } from "@actor-kit/client";
import type { LinkedView } from "@actor-kit/core";
import { createActorContext } from "./context";

/**
 * Create a typed React context from a contract (v3).
 * TView and TMessage are inferred from the contract's views and messages.
 */
export function actorContext<TContract extends { readonly name: string; readonly def: Record<string, unknown> }>(
  contract: TContract,
): ReturnType<typeof createActorContext<LinkedView<TContract>, ContractMessages<TContract>>>;

/**
 * Create a typed React context from a contract type (no runtime import).
 * Use `import type { MyContract } from "..."` + `actorContext<typeof MyContract>()`.
 */
export function actorContext<
  TContract extends { readonly name: string; readonly def: Record<string, unknown> },
>(): ReturnType<typeof createActorContext<LinkedView<TContract>, ContractMessages<TContract>>>;

/**
 * Create a typed React context from an ActorClientFactory type (legacy).
 * TView and TMessage are extracted from the factory type — no manual generics needed.
 */
export function actorContext<TFactory extends ActorClientFactory<unknown, { type: string }>>(): ReturnType<
  typeof createActorContext<InferView<TFactory>, InferMessage<TFactory>>
>;

// Implementation — overloads provide the real types, implementation is loosely typed
// biome-ignore lint/suspicious/noExplicitAny: implementation must be loose to satisfy all overload return types
export function actorContext(_contract?: unknown): any {
  return createActorContext();
}
