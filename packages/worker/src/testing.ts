// Pure-logic runtime utilities — separate entrypoint to avoid cloudflare:workers via actor.ts
// Used by @actor-kit/test and unit tests that run outside CF runtime

// Auth
export { createAccessToken, getCallerFromToken } from "./auth";
// Callback builder
export { callback } from "./callback";
// Contract builder
export type { ActorContract } from "./define";
export { defineActor } from "./define";
// Message builder
export { message } from "./message";
// Actor references
export type { ActorRef } from "./ref";
export { createRef } from "./ref";
// CDC
export type { ChangeEntry } from "./runtime/cdc";
export { createChangeEntry } from "./runtime/cdc";
// Message router
export type { RouteResult } from "./runtime/message-router";
export { routeMessage } from "./runtime/message-router";
// Outbox
export type { OutboxEntry, OutboxStorage } from "./runtime/outbox";
export { createOutbox } from "./runtime/outbox";
// Role resolution
export type { RolePredicate } from "./runtime/roles";
export { resolveRole } from "./runtime/roles";
// Route parsing
export type { ActorRoute } from "./runtime/route-to-actor";
export { parseActorRoute } from "./runtime/route-to-actor";
// State resolution
export type { ParallelStates, SequentialStates } from "./runtime/states";
export { resolveMessagesForState } from "./runtime/states";
// Timer utilities
export { parseDuration } from "./runtime/timers";
