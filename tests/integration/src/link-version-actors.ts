/**
 * Actors used by tests/integration/link-versions.test.ts: a Notice (link source, journaled), the
 * same Notice with `journal: false`, and a Reader that links to either and counts how many link
 * updates it has run.
 */

import { schema, string, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, link, message } from "@actor-kit/worker";
import { z } from "zod";

type NoticeState = { text: string };

export const NoticeContract = defineActor("notice", {
  input: z.object({ text: z.string() }),
  init: ({ text }: { text: string }): NoticeState => ({ text }),
  roles: { reader: () => true },
  messages: {
    EDIT: message(z.object({ text: z.string() }), (_state: NoticeState, { text }) => ({ text })),
  },
  views: {
    reader: view.shared(schema({ text: string }), (state: NoticeState) => ({ text: state.text })),
  },
});

export const NoticeNoJournalContract = defineActor("notice-no-journal", { ...NoticeContract.def, journal: false });

/** The same Notice with Studio (its __restore RPC), for "restore notifies links" (ADR-018 F). */
export const NoticeStudioContract = defineActor("notice-studio", { ...NoticeContract.def, studio: { enabled: true } });

export const Notice = createActorClass(NoticeContract);
export const NoticeNoJournal = createActorClass(NoticeNoJournalContract);
export const NoticeStudio = createActorClass(NoticeStudioContract);

type ReaderState = { text: string; updates: number };

const LinkedText = z.object({ text: z.string() });
const onUpdate = (state: ReaderState, linked: unknown): ReaderState => ({
  text: LinkedText.parse(linked).text,
  updates: state.updates + 1,
});

export const ReaderContract = defineActor("reader", {
  input: z.object({}),
  init: (): ReaderState => ({ text: "", updates: 0 }),
  roles: { viewer: () => true },
  links: {
    notice: link(NoticeContract, { onUpdate }),
    quiet: link(NoticeNoJournalContract, { onUpdate }),
    studio: link(NoticeStudioContract, { onUpdate }),
  },
  messages: {
    FOLLOW: message(
      z.object({ via: z.enum(["notice", "quiet", "studio"]), id: z.string() }),
      (state: ReaderState, p, ctx) => {
        ctx.link(p.via, p.id);
        return state;
      },
    ),
  },
  views: {
    viewer: view.shared(schema({ text: string, updates: uint32 }), (state: ReaderState) => ({
      text: state.text,
      updates: state.updates,
    })),
  },
});

export const Reader = createActorClass(ReaderContract);
