/**
 * actorContext() — create a typed React context from an ActorClientFactory.
 *
 * Usage:
 *   import { actorClient } from "actor-kit/client";
 *   import { actorContext } from "actor-kit/react";
 *
 *   const CounterClient = actorClient(CounterView).events<CounterEvent>();
 *   const CounterCtx = actorContext<typeof CounterClient>();
 *
 *   <CounterCtx.Provider client={client}>
 *     <Counter />
 *   </CounterCtx.Provider>
 */

import type { ActorClientFactory, InferEvent, InferView } from "../client/builder";
import { createActorContext } from "./context";

/**
 * Create a typed React context from an ActorClientFactory type.
 *
 * TView and TEvent are extracted from the factory type — no manual generics needed.
 *
 * @example
 * const CounterClient = actorClient(CounterView).events<CounterEvent>();
 * const CounterCtx = actorContext<typeof CounterClient>();
 */
export function actorContext<TFactory extends ActorClientFactory<unknown, { type: string }>>(): ReturnType<
  typeof createActorContext<InferView<TFactory>, InferEvent<TFactory>>
> {
  return createActorContext<InferView<TFactory>, InferEvent<TFactory>>();
}
