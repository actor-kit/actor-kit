/**
 * What a projection receives (ADR-019 E): a published event as the actor's `publish` sends it
 * (`@actor-kit/worker` PublishedBody), parsed at the boundary.
 */

import { z } from "zod";

const positiveInt = z.number().int().positive();

/** A Queue message body, as `publish` sends it. */
export const PublishedEventSchema = z.object({
  actorType: z.string().min(1),
  actorId: z.string().min(1),
  seq: positiveInt,
  index: z.number().int().nonnegative(),
  name: z.string().min(1),
  payload: z.unknown(),
  at: z.number(),
  causationId: z.string(),
  correlationId: z.string(),
  idempotencyKey: z.string(),
  position: positiveInt,
});

/**
 * One published event as `apply` sees it, the same live and in a rebuild: no delivery fields
 * (`index`, `idempotencyKey`), which a journal does not record. `position` numbers the actor's
 * published events 1, 2, 3... without gaps; `(actorType, actorId, position)` names one event.
 */
export const ProjectionEventSchema = z.object({
  actorType: z.string().min(1),
  actorId: z.string().min(1),
  seq: positiveInt,
  position: positiveInt,
  name: z.string().min(1),
  payload: z.unknown(),
  at: z.number(),
  causationId: z.string(),
  correlationId: z.string(),
});
export type ProjectionEvent = z.infer<typeof ProjectionEventSchema>;

/** The event without its delivery fields. */
export function projectionEvent(body: z.infer<typeof PublishedEventSchema>): ProjectionEvent {
  const { index: _index, idempotencyKey: _key, ...event } = body;
  return event;
}

/** An actor: the unit events are ordered in. */
export interface ActorKey {
  readonly actorType: string;
  readonly actorId: string;
}
