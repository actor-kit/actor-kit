/**
 * actorClient() — typed builder for actor client instances.
 *
 * Separates the type contract (compile-time) from the runtime connection.
 * This module is React-free — React bindings are in @actor-kit/react.
 *
 * Usage:
 *   // Define the contract (co-locate with actor definition)
 *   export const CounterClient = actorClient(CounterView).events<CounterEvent>();
 *
 *   // Create a runtime connection
 *   const client = CounterClient.create({ url, accessToken });
 */

import type { FieldDescriptor, Infer, SchemaDefinition } from "@actor-kit/core";
import { type ActorClient, createActorClient } from "./client";

/** Runtime options for creating a client connection. */
export interface CreateOptions {
  url: string;
  accessToken: string;
  roleNames?: string[];
  WebSocketImpl?: typeof WebSocket;
  onRedirect?: (target: { actorType: string; actorId: string }) => void;
  onError?: (error: { message: string; error: string }) => void;
  maxReconnectAttempts?: number;
}

/** Typed actor client factory — knows TView and TEvent at compile time. */
export interface ActorClientFactory<TView, TEvent extends { type: string }> {
  /** Create a runtime WebSocket connection with typed view and events. */
  create(options: CreateOptions): ActorClient<TView, TEvent>;

  /** Narrow the event type. Returns a new factory with the same TView and a stricter TEvent. */
  events<E extends { type: string }>(): ActorClientFactory<TView, E>;
}

/** Extract the view type from an ActorClientFactory. */
export type InferView<T> = T extends ActorClientFactory<infer V, infer _E> ? V : never;

/** Extract the event type from an ActorClientFactory. */
export type InferEvent<T> = T extends ActorClientFactory<infer _V, infer E> ? E : never;

/**
 * Create a typed actor client factory from a view schema.
 *
 * TView is inferred from the schema — no generics needed.
 * Call .events<E>() to narrow the event type.
 */
export function actorClient<TShape extends Record<string, FieldDescriptor>>(
  viewSchema: SchemaDefinition<TShape>,
): ActorClientFactory<Infer<SchemaDefinition<TShape>>, { type: string; [key: string]: unknown }> {
  type TView = Infer<SchemaDefinition<TShape>>;

  function buildFactory<TEvent extends { type: string }>(): ActorClientFactory<TView, TEvent> {
    return {
      create(options: CreateOptions): ActorClient<TView, TEvent> {
        return createActorClient<TShape, TEvent>({
          ...options,
          viewSchema,
        });
      },

      events<E extends { type: string }>(): ActorClientFactory<TView, E> {
        return buildFactory<E>();
      },
    };
  }

  return buildFactory<{ type: string; [key: string]: unknown }>();
}
