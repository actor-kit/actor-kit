import { CallerType } from "./types";

export const HEADERS = {
  X_CALLER_ID: "X-Caller-ID",
  X_CALLER_TYPE: "X-Caller-Type",
  X_ACTOR_ID: "X-Actor-ID",
  X_ACTOR_TYPE: "X-Actor-Type",
};

/**
 * Defines the types of callers that can interact with the actor system.
 * Each type represents a different source of events with varying levels of trust and permissions.
 * Note: SYSTEM events are handled internally by Actor Kit and are not defined by the user.
 */
export const CallerTypes: Record<CallerType, CallerType> = {
  client: "client",
  system: "system", // Handled internally by Actor Kit
  service: "service",
};

export const PERSISTED_SNAPSHOT_KEY = "persistedSnapshot";
