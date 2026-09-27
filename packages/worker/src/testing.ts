// Pure-logic runtime utilities — separate entrypoint to avoid cloudflare:workers via actor.ts
// Used by @actor-kit/test and unit tests that run outside CF runtime

// Contract builder
export type { ActorContract } from "./define";
export { defineActor } from "./define";
// Identity (Worker-trust model)
export { CALLER_ID_HEADER, CALLER_TYPE_HEADER, withCallerIdentity } from "./identity";
// Link declaration
export type { LinkDef, LinkErrorCode } from "./link";
export { link } from "./link";
// Message builder
export { message } from "./message";
// Actor references
export type { ActorRef, LocationHint } from "./ref";
export { createRef } from "./ref";
// CDC
export type { ChangeEntry } from "./runtime/cdc";
export { createChangeEntry } from "./runtime/cdc";
export { getTokenFromRequest } from "./runtime/get-token";
// Message router
export type { RouteResult } from "./runtime/message-router";
export { routeMessage } from "./runtime/message-router";
// Outbox
export type { ExecutionEntry, ForwardCall, ForwardEntry, LinkCall, UnlinkCall } from "./runtime/outbox";
export { createOutbox } from "./runtime/outbox";
// Namespace resolution
export { resolveNamespace } from "./runtime/resolve-namespace";
// Role resolution
export type { RolePredicate } from "./runtime/roles";
export { resolveRole } from "./runtime/roles";
// Route parsing
export type { ActorRoute } from "./runtime/route-to-actor";
export { parseActorRoute } from "./runtime/route-to-actor";
// Studio connection row parsing (pure)
export { toStudioConnections } from "./runtime/studio-connections";
