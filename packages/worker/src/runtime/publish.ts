/**
 * The outbound event stream (ADR-017 §3).
 *
 * `publish: { queue, events }` sends each emitted event named in `events` to the Queue binding
 * `queue`. The Durable Object writes one outbox row per published event in the transition's
 * transaction, under the event's effect id (`seq:index`), and sends it after commit with the
 * outbox's retries, dead letters and redrive (ADR-015 D1). Consumers dedupe on `idempotencyKey`.
 */

import { formatEffectId } from "./effect-id";
import { idempotencyKey as effectIdempotencyKey } from "./effect-info";
import type { EmittedEffect } from "./outbox";
import { eventId } from "./trace";

/** The outbox "service" a published event's row runs under. Reserved: actors cannot declare it. */
export const PUBLISH_SERVICE = "__publish";

export interface PublishOption {
  readonly queue: string;
  readonly events: readonly string[];
}

export interface PublishConfig {
  readonly queue: string;
  readonly events: ReadonlySet<string>;
}

/** Validate `publish` at definition time: a queue, declared events, no service named PUBLISH_SERVICE. */
export function resolvePublish(
  option: PublishOption | undefined,
  events: Record<string, unknown> | undefined,
  services: Record<string, unknown> | undefined,
): PublishConfig | null {
  if (option === undefined) return null;
  if (option.queue === "") throw new Error("publish.queue must name a Queue binding");
  checkDeclared(option.events, events ?? {});
  if (services !== undefined && Object.hasOwn(services, PUBLISH_SERVICE)) {
    throw new Error(`The service name "${PUBLISH_SERVICE}" is reserved for publish`);
  }
  return { queue: option.queue, events: new Set(option.events) };
}

/** Every published name must be a declared event. */
function checkDeclared(names: readonly string[], events: Record<string, unknown>): void {
  for (const name of names) {
    if (!Object.hasOwn(events, name)) throw new Error(`publish: event "${name}" is not declared in events`);
  }
}

/** What a consumer receives. */
export interface PublishedBody {
  readonly actorType: string;
  readonly actorId: string;
  readonly seq: number;
  readonly index: number;
  readonly name: string;
  readonly payload: unknown;
  readonly at: number;
  readonly causationId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface PublishedMessage {
  readonly effectId: string;
  readonly index: number;
  readonly body: PublishedBody;
}

/** The messages a committed transition publishes: one per emitted event named in `publish.events`. */
export function publishedMessages(
  config: PublishConfig,
  emitted: readonly EmittedEffect[],
  transition: { actorType: string; actorId: string; seq: number; at: number; correlationId: string },
): PublishedMessage[] {
  const { actorType, actorId, seq, at, correlationId } = transition;
  return emitted
    .filter((event) => config.events.has(event.name))
    .map(({ name, payload, index }) => {
      const effectId = formatEffectId(seq, index);
      // The same key every effect has (ADR-016 §1): unique across the deployment, stable across retries.
      const idempotencyKey = effectIdempotencyKey(actorType, actorId, effectId);
      const causationId = eventId(actorType, actorId, seq);
      const body = { actorType, actorId, seq, index, name, payload, at, causationId, correlationId, idempotencyKey };
      return { effectId, index, body };
    });
}

/** Send one published message to its Queue binding (the outbox runs this as a service try). */
export async function sendToQueue(env: unknown, queue: string, body: unknown): Promise<null> {
  const binding: unknown = typeof env === "object" && env !== null ? Reflect.get(env, queue) : undefined;
  const send: unknown = typeof binding === "object" && binding !== null ? Reflect.get(binding, "send") : undefined;
  if (typeof send !== "function") throw new Error(`Queue binding "${queue}" is not bound`);
  await Reflect.apply(send, binding, [body]);
  return null;
}
