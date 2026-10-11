/**
 * Replaying actor journals into a read model (ADR-019 E): the journal query (ADR-019 F) is read
 * oldest first, and each emitted event the actor publishes becomes a projection event. Positions are
 * counted the way the live actor assigns them (published events, in seq order), so a rebuild ends with
 * the cursors live consumption continues from. This holds while the journal is complete from `init`
 * and `publish.events` has not changed.
 */

import { z } from "zod";
import type { ActorKey, ProjectionEvent } from "./event";

/** Reads one page of an actor's journal through the journal query (see sources.ts for adapters). */
export interface JournalSource {
  journal(
    actorType: string,
    actorId: string,
    query: { readonly order: "asc"; readonly from: number; readonly limit: number },
  ): Promise<unknown>;
}

/** The slice of a journal page a rebuild reads (`__journal` / `GET .../journal` entries). */
const JournalPageSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      seq: z.number().int().positive(),
      causeType: z.string(),
      emitted: z.array(z.object({ name: z.string(), payload: z.unknown(), published: z.boolean() })),
      correlationId: z.string().nullable(),
      createdAt: z.number(),
    }),
  ),
  hasMore: z.boolean(),
});
type JournalPage = z.infer<typeof JournalPageSchema>;
type JournalEntry = JournalPage["entries"][number];

export const DEFAULT_PAGE_SIZE = 500;

async function readPage(source: JournalSource, actor: ActorKey, from: number, limit: number): Promise<JournalPage> {
  const parsed = JournalPageSchema.safeParse(await source.journal(actor.actorType, actor.actorId, { order: "asc", from, limit }));
  if (!parsed.success) {
    throw new Error(`rebuild: malformed journal page for ${actor.actorType}/${actor.actorId}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function assertComplete(actor: ActorKey, first: JournalEntry | undefined): void {
  const name = `${actor.actorType}/${actor.actorId}`;
  if (first === undefined) throw new Error(`rebuild: ${name} has no journal entries (journal off, or never spawned)`);
  if (first.causeType !== "init") {
    throw new Error(`rebuild: the journal of ${name} starts at seq ${first.seq} (${first.causeType}), not init: it was pruned`);
  }
}

/** Every published event in an actor's journal, oldest first, with its live position. */
export async function* journalEvents(
  source: JournalSource,
  actor: ActorKey,
  pageSize: number,
): AsyncGenerator<ProjectionEvent> {
  let position = 0;
  let from = 1;
  for (;;) {
    const page = await readPage(source, actor, from, pageSize);
    if (from === 1) assertComplete(actor, page.entries[0]);
    for (const entry of page.entries) {
      for (const emitted of entry.emitted.filter((e) => e.published)) {
        position += 1;
        yield {
          ...actor,
          seq: entry.seq,
          position,
          name: emitted.name,
          payload: emitted.payload,
          at: entry.createdAt,
          causationId: entry.id,
          correlationId: entry.correlationId ?? entry.id,
        };
      }
      from = entry.seq + 1;
    }
    if (!page.hasMore) return;
  }
}
