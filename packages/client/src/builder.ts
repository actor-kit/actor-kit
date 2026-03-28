/**
 * actorClient() — typed builder for actor client instances.
 *
 * Separates the type contract (compile-time) from the runtime connection.
 * This module is React-free — React bindings are in @actor-kit/react.
 *
 * Usage (v3 — contract-derived):
 *   import { defineActor, message } from "@actor-kit/worker";
 *   const Counter = defineActor("counter", { init, messages, views });
 *   const CounterClient = actorClient(Counter);
 *   const client = CounterClient.create({ url, accessToken });
 *
 * Usage (legacy — manual schema):
 *   const CounterClient = actorClient(CounterView).events<CounterEvent>();
 *   const client = CounterClient.create({ url, accessToken });
 */

import type { FieldDescriptor, Infer, SchemaDefinition } from "@actor-kit/core";
import { type ActorClient, createActorClient } from "./client";

/** Runtime options for creating a client connection. */
export interface CreateOptions {
  url: string;
  accessToken?: string | undefined;
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

// --- Contract type inference helpers ---

/**
 * Extract the event union from a contract's flat messages.
 * Each message name K becomes { type: K } & payload.
 * Payload is inferred from the Zod schema's _output type.
 *
 * Only matches flat messages (values have `schema` property).
 * Nested role-based messages fall through to loose event typing.
 */
export type ContractEvents<T> = T extends {
  def: { messages: Record<string, { schema: { _output: unknown } }> };
}
  ? {
      [K in keyof T["def"]["messages"] & string]: T["def"]["messages"][K] extends {
        schema: { _output: infer P };
      }
        ? { type: K } & P
        : { type: K };
    }[keyof T["def"]["messages"] & string]
  : { type: string; [key: string]: unknown };

/**
 * Extract the view union from a contract's views.
 * Uses the schema's Infer type (same type used for binary decoding).
 */
export type ContractView<T> = T extends {
  def: { views: Record<string, unknown> };
}
  ? {
      [K in keyof T["def"]["views"]]: T["def"]["views"][K] extends {
        schema: SchemaDefinition<infer TShape>;
      }
        ? Infer<SchemaDefinition<TShape>>
        : never;
    }[keyof T["def"]["views"]]
  : unknown;

// --- Overloads ---

/**
 * Create a typed actor client factory from a contract (v3).
 * TView and TEvent are inferred from the contract's views and messages.
 */
export function actorClient<TContract extends { readonly name: string; readonly def: Record<string, unknown> }>(
  contract: TContract,
): ActorClientFactory<ContractView<TContract>, ContractEvents<TContract>>;

/**
 * Create a typed actor client factory from a view schema (legacy).
 * Call .events<E>() to narrow the event type.
 */
export function actorClient<TShape extends Record<string, FieldDescriptor>>(
  viewSchema: SchemaDefinition<TShape>,
): ActorClientFactory<Infer<SchemaDefinition<TShape>>, { type: string; [key: string]: unknown }>;

// Implementation
export function actorClient(
  arg:
    | { readonly name: string; readonly def: Record<string, unknown> }
    | SchemaDefinition<Record<string, FieldDescriptor>>,
): ActorClientFactory<unknown, { type: string }> {
  // Detect contract vs viewSchema
  if ("name" in arg && "def" in arg) {
    return buildContractFactory(arg);
  }
  return buildSchemaFactory(arg as SchemaDefinition<Record<string, FieldDescriptor>>);
}

// --- Contract-based factory ---

function buildContractFactory(contract: {
  readonly name: string;
  readonly def: Record<string, unknown>;
}): ActorClientFactory<unknown, { type: string }> {
  const def = contract.def;

  // Extract role names from def.roles (matches worker's Object.keys(def.roles) for roleIndex)
  const roles =
    typeof def === "object" && def !== null && "roles" in def
      ? (def as { roles: Record<string, unknown> }).roles
      : undefined;
  const roleNames = roles ? Object.keys(roles) : undefined;

  // Extract per-role view schemas for binary decoding
  const views =
    typeof def === "object" && def !== null && "views" in def
      ? (def as { views: Record<string, { schema?: SchemaDefinition<Record<string, FieldDescriptor>> }> }).views
      : undefined;

  let viewSchemas: Record<string, SchemaDefinition<Record<string, FieldDescriptor>>> | undefined;
  if (views) {
    const schemas: Record<string, SchemaDefinition<Record<string, FieldDescriptor>>> = {};
    for (const [roleName, viewDef] of Object.entries(views)) {
      if (viewDef && "schema" in viewDef && viewDef.schema) {
        schemas[roleName] = viewDef.schema;
      }
    }
    if (Object.keys(schemas).length > 0) {
      viewSchemas = schemas;
    }
  }

  return {
    create(options: CreateOptions): ActorClient<unknown, { type: string }> {
      return createActorClient({
        ...options,
        viewSchemas,
        roleNames: options.roleNames ?? roleNames,
      });
    },
    events<E extends { type: string }>(): ActorClientFactory<unknown, E> {
      return this as unknown as ActorClientFactory<unknown, E>;
    },
  };
}

// --- Schema-based factory (legacy) ---

function buildSchemaFactory<TShape extends Record<string, FieldDescriptor>>(
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
