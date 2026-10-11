/**
 * `projection({ queue, db, apply })` (ADR-019 E): a Cloudflare Queue consumer for the events actors
 * publish (ADR-017 §3) that keeps a read model in D1.
 *
 * Per actor, events are applied once and in `position` order: an event at or before the actor's
 * cursor is a duplicate (acked); the next one is applied in one D1 batch with its cursor row, so the
 * read model and the cursor never disagree; a later one is buffered (acked) until the gap fills. A
 * failing apply retries that actor's messages with a delay. `rebuild()` replays actor journals into a
 * fresh read model with the same positions.
 */

import { ActorKitError } from "@actor-kit/core";
import { type ActorKey, type ProjectionEvent, projectionEvent, PublishedEventSchema } from "./event";
import { DEFAULT_PAGE_SIZE, type JournalSource, journalEvents } from "./rebuild";
import { type BufferedActor, createStore, type SqlDatabase, type SqlStatement } from "./store";

/** Structural slice of a Queue message (`Message` satisfies it). */
export interface QueueMessage {
  readonly body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** Structural slice of a Queue batch (`MessageBatch` satisfies it). */
export interface QueueBatch {
  readonly queue: string;
  readonly messages: readonly QueueMessage[];
}

export interface ApplyContext<Env, Db extends SqlDatabase> {
  readonly db: Db;
  readonly env: Env;
  /** Where the event came from. */
  readonly via: "queue" | "rebuild";
}

type Statements<Db extends SqlDatabase> = ReturnType<Db["prepare"]>[];

export interface ProjectionOptions<Env, Db extends SqlDatabase> {
  /** The Queue this consumer handles (its name in wrangler config: `batch.queue`). */
  readonly queue: string;
  /** The D1 database that holds the read model and the projection's bookkeeping. */
  readonly db: (env: Env) => Db;
  /**
   * The read-model writes for one event, as statements of `db`; they run in one batch with the
   * event's cursor. Return `[]` for events this read model ignores. Must not write elsewhere.
   */
  readonly apply: (event: ProjectionEvent, ctx: ApplyContext<Env, Db>) => Statements<Db> | Promise<Statements<Db>>;
  /** Statements that empty the read model before a rebuild. */
  readonly reset?: (ctx: { readonly db: Db; readonly env: Env }) => Statements<Db> | Promise<Statements<Db>>;
  /** Prefix of the bookkeeping tables (`<table>_cursor`, `<table>_buffer`). Default `actor_kit_projection`. */
  readonly table?: string;
  /** Delay before a message whose apply failed comes back. Default 5. */
  readonly retryDelaySeconds?: number;
  /** Cursor rows kept behind the newest per actor (guards slow concurrent consumers). Default 1000. */
  readonly keepCursorRows?: number;
}

export interface RebuildOptions {
  readonly source: JournalSource;
  readonly actors: Iterable<ActorKey> | AsyncIterable<ActorKey>;
  /** Journal entries per request. Default 500. */
  readonly pageSize?: number;
}

export interface Projection<Env> {
  /** Whether a batch comes from this projection's queue. */
  handles(batch: { readonly queue: string }): boolean;
  /** The Queue consumer: `async queue(batch, env) { await reads.queue(batch, env) }`. */
  queue(batch: QueueBatch, env: Env): Promise<void>;
  /** Empty the read model (`reset`) and replay the actors' journals into it. */
  rebuild(env: Env, options: RebuildOptions): Promise<{ actors: number; events: number }>;
  /** Actors with buffered events, waiting for an earlier one. */
  buffered(env: Env): Promise<BufferedActor[]>;
}

/** One actor's messages in a batch. */
interface Group {
  readonly actor: ActorKey;
  readonly events: ProjectionEvent[];
  readonly messages: QueueMessage[];
}

const actorKey = (actor: ActorKey): string => JSON.stringify([actor.actorType, actor.actorId]);

export function projection<Env, Db extends SqlDatabase>(options: ProjectionOptions<Env, Db>): Projection<Env> {
  const store = createStore(options.table ?? "actor_kit_projection", options.keepCursorRows ?? 1000);
  const delaySeconds = options.retryDelaySeconds ?? 5;

  /**
   * Apply one event with its cursor row. When the batch fails because another consumer already
   * committed this position (its cursor row exists), the event is applied: nothing to do.
   */
  async function applyOne(db: Db, env: Env, event: ProjectionEvent, via: ApplyContext<Env, Db>["via"]) {
    const statements: SqlStatement[] = [...store.applied(db, event), ...(await options.apply(event, { db, env, via }))];
    try {
      await db.batch(statements);
    } catch (error) {
      if ((await store.cursor(db, event)) < event.position) throw error;
    }
  }

  /** Apply an actor's buffered events while they follow its cursor without a gap. */
  async function drain(db: Db, env: Env, actor: ActorKey): Promise<void> {
    let applied = await store.cursor(db, actor);
    for (const event of await store.pending(db, actor, applied)) {
      if (event.position !== applied + 1) return;
      await applyOne(db, env, event, "queue");
      applied = event.position;
    }
  }

  async function consume(db: Db, env: Env, group: Group): Promise<void> {
    const { actor, events, messages } = group;
    try {
      await store.buffer(db, events);
      await drain(db, env, actor);
      for (const message of messages) message.ack();
    } catch {
      for (const message of messages) message.retry({ delaySeconds });
    }
  }

  return {
    handles: (batch) => batch.queue === options.queue,

    async queue(batch, env) {
      if (batch.queue !== options.queue) {
        throw new ActorKitError("invalid_projection", `projection for queue "${options.queue}" got a batch from "${batch.queue}"`);
      }
      const db = options.db(env);
      await store.ensure(db);
      const byActor = new Map<string, Group>();
      for (const message of batch.messages) {
        const parsed = PublishedEventSchema.safeParse(message.body);
        if (!parsed.success) {
          // Never valid: retried until the queue's dead letter queue takes it.
          message.retry();
          continue;
        }
        const event = projectionEvent(parsed.data);
        const group = byActor.get(actorKey(event)) ?? { actor: event, events: [], messages: [] };
        group.events.push(event);
        group.messages.push(message);
        byActor.set(actorKey(event), group);
      }
      for (const group of byActor.values()) await consume(db, env, group);
    },

    async rebuild(env, { source, actors, pageSize = DEFAULT_PAGE_SIZE }) {
      const db = options.db(env);
      await store.ensure(db);
      await db.batch([...store.reset(db), ...((await options.reset?.({ db, env })) ?? [])]);
      let count = 0;
      let events = 0;
      for await (const actor of actors) {
        count += 1;
        for await (const event of journalEvents(source, actor, pageSize)) {
          await applyOne(db, env, event, "rebuild");
          events += 1;
        }
      }
      return { actors: count, events };
    },

    buffered: (env) => store.buffered(options.db(env)),
  };
}
