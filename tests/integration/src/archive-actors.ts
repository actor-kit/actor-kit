/**
 * Journal archive to R2 (ADR-019 D): a tally that keeps 4 events locally, checkpoints every 2, and
 * archives what it prunes to the JOURNAL_ARCHIVE bucket; and one whose archive binding is missing.
 */
import { createActorClass, setup } from "@actor-kit/worker";
import { z } from "zod";

type S = { total: number };

const tally = setup({});
const add = tally.message(z.object({ n: z.number() }), (s: S, { n }) => ({ total: s.total + n }));
const base = {
  input: z.object({}),
  init: (): S => ({ total: 0 }),
  roles: { clerk: () => true },
  messages: { ADD: add },
  views: {},
};

export const ArchivedTally = tally.actor("archived-tally", {
  ...base,
  journal: { keep: 4, checkpointEvery: 2, archive: "JOURNAL_ARCHIVE" },
});
export const ArchivedTallyActor = createActorClass(ArchivedTally);

export const UnboundArchive = tally.actor("unbound-archive", {
  ...base,
  journal: { keep: 4, checkpointEvery: 2, archive: "NO_SUCH_BUCKET" },
});
export const UnboundArchiveActor = createActorClass(UnboundArchive);
