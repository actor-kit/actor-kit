/**
 * actorContext() — create a typed React context from a contract or ActorClientFactory.
 *
 * Usage (v3 — contract-derived):
 *   import { defineActor, message } from "actor-kit";
 *   import { actorContext } from "actor-kit/react";
 *
 *   const Counter = defineActor("counter", { init, messages, views });
 *   const CounterCtx = actorContext(Counter);
 *
 * Usage (legacy — factory-derived):
 *   import { actorClient } from "actor-kit/client";
 *   import { actorContext } from "actor-kit/react";
 *
 *   const CounterClient = actorClient(CounterView).events<CounterEvent>();
 *   const CounterCtx = actorContext<typeof CounterClient>();
 */

import type { ActorClientFactory, ContractEvents, ContractView, InferEvent, InferView } from "../client/builder";
import { createActorContext } from "./context";

/**
 * Create a typed React context from a contract (v3).
 * TView and TEvent are inferred from the contract's views and messages.
 */
export function actorContext<TContract extends { readonly name: string; readonly def: Record<string, unknown> }>(
  contract: TContract,
): ReturnType<typeof createActorContext<ContractView<TContract>, ContractEvents<TContract>>>;

/**
 * Create a typed React context from an ActorClientFactory type (legacy).
 * TView and TEvent are extracted from the factory type — no manual generics needed.
 */
export function actorContext<TFactory extends ActorClientFactory<unknown, { type: string }>>(): ReturnType<
  typeof createActorContext<InferView<TFactory>, InferEvent<TFactory>>
>;

// Implementation
export function actorContext(_contract?: {
  readonly name: string;
  readonly def: Record<string, unknown>;
}): ReturnType<typeof createActorContext> {
  return createActorContext();
}
