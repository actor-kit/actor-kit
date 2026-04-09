// @actor-kit/client — browser-safe actor client SDK (no CF deps, no React)

export type {
  ActorClientFactory,
  ContractEvents,
  ContractEvents as ContractMessages,
  ContractView,
  CreateOptions,
  InferEvent,
  InferEvent as InferMessage,
  InferView,
} from "./builder";
export { actorClient } from "./builder";
export type { ActorClient, ClientOptions, ConnectionState } from "./client";
export { createActorClient } from "./client";
export { buildUrl, inferProtocol } from "./url";
