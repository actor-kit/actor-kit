// @actor-kit/projection — read models from published actor events (ADR-019 E)

export type { ActorKey, ProjectionEvent } from "./event";
export { ProjectionEventSchema, PublishedEventSchema } from "./event";
export type {
  ApplyContext,
  Projection,
  ProjectionOptions,
  QueueBatch,
  QueueMessage,
  RebuildOptions,
} from "./projection";
export { projection } from "./projection";
export type { JournalSource } from "./rebuild";
export type { BufferedActor, SqlDatabase, SqlStatement } from "./store";
export type { ActorNamespace, StudioJournalSourceOptions } from "./sources";
export { actorJournalSource, studioJournalSource } from "./sources";
