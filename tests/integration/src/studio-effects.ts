/**
 * Actors used by tests/integration/studio-effects.test.ts: a Bulletin (link
 * target) and a Desk that runs a slow service and links to a Bulletin, so the
 * studio Outbox and Links data can be observed changing live.
 */

import { schema, string, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, link, message } from "@actor-kit/worker";
import { z } from "zod";

type BulletinState = { headline: string; edits: number };

export const BulletinContract = defineActor("bulletin", {
  input: z.object({ headline: z.string() }),
  init: ({ headline }: { headline: string }): BulletinState => ({ headline, edits: 0 }),
  roles: { reader: () => true },
  messages: {
    EDIT: message(z.object({ headline: z.string() }), (state: BulletinState, { headline }) => ({
      headline,
      edits: state.edits + 1,
    })),
  },
  views: {
    reader: view.shared(schema({ headline: string, edits: uint32 }), (state: BulletinState) => ({
      headline: state.headline,
      edits: state.edits,
    })),
  },
  studio: { enabled: true },
});

export const Bulletin = createActorClass(BulletinContract);

type DeskState = { headline: string; result: string };

const JobSchema = z.object({ tag: z.string(), delayMs: z.number().int().min(0), fail: z.boolean() });
type Job = z.infer<typeof JobSchema>;

export const DeskContract = defineActor("desk", {
  input: z.object({}),
  init: (): DeskState => ({ headline: "", result: "" }),
  roles: { clerk: () => true },
  services: {
    JOB: {
      // One try: the tests watch a failing job go pending → failed without waiting out retries.
      retry: { attempts: 1 },
      fn: async (job: Job): Promise<{ tag: string }> => {
        await new Promise((resolve) => setTimeout(resolve, job.delayMs));
        if (job.fail) throw new Error(`job ${job.tag} failed`);
        return { tag: job.tag };
      },
      onDone: (state: DeskState, result: { tag: string }) => ({ ...state, result: `done:${result.tag}` }),
      onError: (state: DeskState, error: { message: string }) => ({ ...state, result: `error:${error.message}` }),
    },
  },
  links: {
    bulletin: link(BulletinContract, {
      onUpdate: (state: DeskState, linked: unknown) => ({
        ...state,
        headline: z.object({ headline: z.string() }).parse(linked).headline,
      }),
    }),
  },
  messages: {
    RUN: message(JobSchema, (state: DeskState, job, ctx) => {
      ctx.execute("JOB", job);
      return state;
    }),
    FOLLOW: message(z.object({ id: z.string() }), (state: DeskState, { id }, ctx) => {
      ctx.link("bulletin", id);
      return state;
    }),
    UNFOLLOW: message(z.object({ id: z.string() }), (state: DeskState, { id }, ctx) => {
      ctx.unlink("bulletin", id);
      return state;
    }),
  },
  views: {
    clerk: view.shared(schema({ headline: string, result: string }), (state: DeskState) => ({
      headline: state.headline,
      result: state.result,
    })),
  },
  studio: { enabled: true },
});

export const Desk = createActorClass(DeskContract);
