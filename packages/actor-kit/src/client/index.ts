// Client public API (browser-safe — no CF deps, no React)

export { decode } from "../schema/binary";
export { applyDelta } from "../schema/delta";
export type { ParsedFrame } from "../schema/frame";
export { ControlType, FrameType, parseFrame } from "../schema/frame";
export type { ActorClientFactory, ContractEvents, ContractView, CreateOptions, InferEvent, InferView } from "./builder";
export { actorClient } from "./builder";
export type { ActorClient, ConnectionState } from "./client";
export { createActorClient } from "./client";
