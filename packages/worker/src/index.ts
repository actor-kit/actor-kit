// @actor-kit/worker — actor, message, runtime, identity

export type { TypedActorClass } from "./actor";
// Core actor builder + typed DO class
export { actor, createActorClass } from "./actor";
// Contract builder
export type { ActorContract } from "./define";
export { defineActor } from "./define";
// Identity (Worker-trust model)
export { CALLER_ID_HEADER, CALLER_TYPE_HEADER, withCallerIdentity } from "./identity";
// Link declaration
export type { LinkDef, LinkErrorCode } from "./link";
export { link } from "./link";
// Message helpers
export { message } from "./message";
// Actor references
export type { ActorRef, LocationHint } from "./ref";
export { createRef } from "./ref";
export { getTokenFromRequest } from "./runtime/get-token";
// Namespace resolution
export { resolveNamespace } from "./runtime/resolve-namespace";
export type { ActorRoute } from "./runtime/route-to-actor";
// Runtime utilities
export { parseActorRoute } from "./runtime/route-to-actor";
