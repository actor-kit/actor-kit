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
 *   const client = CounterClient.create({ path: "/api/counter/abc", initialView });
 *   client.connect();
 *
 * Usage (legacy — manual schema):
 *   const CounterClient = actorClient(CounterView).events<CounterEvent>();
 *   const client = CounterClient.create({ path, initialView });
 *   client.connect();
 */

import type { ContractMessages, FieldDescriptor, Infer, SchemaDefinition } from "@actor-kit/core";
import { type ActorClient, createActorClient, type WebSocketConstructor } from "./client";

/** Runtime options for creating a client connection. */
export interface CreateOptions<TView = unknown> {
  /** Path on the server (required), e.g. "/api/counter/test-1". */
  path: string;
  /** Host with optional port. Defaults to window.location.host in the browser. */
  host?: string;
  /** Initial view from the server (SSR snapshot). Required. */
  initialView: TView;
  /** Token getter — sent via Sec-WebSocket-Protocol on every (re)connect. */
  getToken?: () => string | Promise<string>;
  /** Headers getter — native (RN/Node) only; throws in the browser. */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  WebSocketImpl?: WebSocketConstructor;
  onRedirect?: (target: { actorType: string; actorId: string }) => void;
  onError?: (error: { message: string; error: string }) => void;
}

/** Typed actor client factory — knows TView and TEvent at compile time. */
export interface ActorClientFactory<TView, TEvent extends { type: string }> {
  /** Create an unconnected client. Call client.connect() to open the WebSocket. */
  create(options: CreateOptions<TView>): ActorClient<TView, TEvent>;

  /** Narrow the message type. Returns a new factory with the same TView and a stricter TMessage. */
  messages<M extends { type: string }>(): ActorClientFactory<TView, M>;

  /** @deprecated Use `messages()` instead. */
  events<E extends { type: string }>(): ActorClientFactory<TView, E>;
}

/** Extract the view type from an ActorClientFactory. */
export type InferView<T> = T extends ActorClientFactory<infer V, infer _E> ? V : never;

/** Extract the event type from an ActorClientFactory. */
export type InferEvent<T> = T extends ActorClientFactory<infer _V, infer E> ? E : never;

// --- Contract type inference helpers ---

export type ContractEvents<T> = ContractMessages<T>;

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

export function actorClient<TContract extends { readonly name: string; readonly def: Record<string, unknown> }>(
  contract: TContract,
): ActorClientFactory<ContractView<TContract>, ContractEvents<TContract>>;

export function actorClient<TShape extends Record<string, FieldDescriptor>>(
  viewSchema: SchemaDefinition<TShape>,
): ActorClientFactory<Infer<SchemaDefinition<TShape>>, { type: string; [key: string]: unknown }>;

// Implementation
export function actorClient(
  arg:
    | { readonly name: string; readonly def: Record<string, unknown> }
    | SchemaDefinition<Record<string, FieldDescriptor>>,
): ActorClientFactory<unknown, { type: string }> {
  if ("name" in arg && "def" in arg) {
    return buildContractFactory(arg);
  }
  return buildSchemaFactory(arg);
}

// --- Contract-based factory ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isViewSchema(value: unknown): value is SchemaDefinition<Record<string, FieldDescriptor>> {
  return isRecord(value) && value["kind"] === "schema" && Array.isArray(value["fields"]);
}

/** Role names in definition order (the server's roleIndex) and the schema of each role's view, if any. */
function contractSchemas(def: Record<string, unknown>): {
  roleNames: string[] | undefined;
  viewSchemas: Record<string, SchemaDefinition<Record<string, FieldDescriptor>>>;
} {
  const roles = def["roles"];
  const views = def["views"];
  const viewSchemas: Record<string, SchemaDefinition<Record<string, FieldDescriptor>>> = {};
  for (const [roleName, viewDef] of Object.entries(isRecord(views) ? views : {})) {
    const viewSchema = isRecord(viewDef) ? viewDef["schema"] : undefined;
    if (isViewSchema(viewSchema)) viewSchemas[roleName] = viewSchema;
  }
  return { roleNames: isRecord(roles) ? Object.keys(roles) : undefined, viewSchemas };
}

function buildContractFactory(contract: {
  readonly name: string;
  readonly def: Record<string, unknown>;
}): ActorClientFactory<unknown, { type: string }> {
  const { roleNames, viewSchemas } = contractSchemas(contract.def);

  function build<TEvent extends { type: string }>(): ActorClientFactory<unknown, TEvent> {
    return {
      create(options: CreateOptions<unknown>): ActorClient<unknown, TEvent> {
        return createActorClient<unknown, TEvent>({
          ...options,
          viewSchemas,
          roleNames,
        });
      },
      messages<M extends { type: string }>(): ActorClientFactory<unknown, M> {
        return build<M>();
      },
      events<E extends { type: string }>(): ActorClientFactory<unknown, E> {
        return build<E>();
      },
    };
  }
  return build<{ type: string }>();
}

// --- Schema-based factory (legacy) ---

function buildSchemaFactory<TShape extends Record<string, FieldDescriptor>>(
  viewSchema: SchemaDefinition<TShape>,
): ActorClientFactory<Infer<SchemaDefinition<TShape>>, { type: string; [key: string]: unknown }> {
  type TView = Infer<SchemaDefinition<TShape>>;

  function buildFactory<TEvent extends { type: string }>(): ActorClientFactory<TView, TEvent> {
    return {
      create(options: CreateOptions<TView>): ActorClient<TView, TEvent> {
        return createActorClient<TShape, TEvent>({
          ...options,
          viewSchema,
        });
      },

      messages<M extends { type: string }>(): ActorClientFactory<TView, M> {
        return buildFactory<M>();
      },

      events<E extends { type: string }>(): ActorClientFactory<TView, E> {
        return buildFactory<E>();
      },
    };
  }

  return buildFactory<{ type: string; [key: string]: unknown }>();
}
