// Pure-logic runtime utilities for @actor-kit/test
// Separate entrypoint to avoid pulling in cloudflare:workers via actor.ts

export { routeMessage } from "./runtime/message-router";
export type { RouteResult } from "./runtime/message-router";
export { resolveRole } from "./runtime/roles";
export type { RolePredicate } from "./runtime/roles";
