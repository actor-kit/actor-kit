// Pure-logic runtime utilities for @actor-kit/test
// Separate entrypoint to avoid pulling in cloudflare:workers via actor.ts

export type { RouteResult } from "./runtime/message-router";
export { routeMessage } from "./runtime/message-router";
export type { RolePredicate } from "./runtime/roles";
export { resolveRole } from "./runtime/roles";
