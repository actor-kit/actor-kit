// @actor-kit/studio — introspection and debugging for actor-kit

export { type AccessDeps, hasScope, type Scope, type StudioPrincipal } from "./access";
export {
  actorKitStudio,
  createActorKitStudio,
  type StudioAuditEvent,
  type StudioHandler,
  type StudioOptions,
  type StudioRoute,
} from "./middleware";
export { StudioRegistry } from "./registry";
