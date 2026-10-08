/**
 * Actors used by the journal integration tests (tests/integration/journal.test.ts, ADR-013).
 *
 * JournalProbe produces every journaled cause: init, message (with ctx.now/id/random and
 * unlink), lifecycle.connect/disconnect, service.onDone/onError, link.onUpdate/onError, migrate.
 * Its "room" link points at NotAnActor, a plain DO with no actor RPC, so subscribing fails
 * and link.onError fires.
 *
 * JournalOff opts out with `journal: false`. JournalKeep prunes (keep 3, checkpoint every 2).
 */

import { DurableObject } from "cloudflare:workers";
import type { DeterministicContext } from "@actor-kit/core";
import { schema, string, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, link, message } from "@actor-kit/worker";
import { z } from "zod";

export class NotAnActor extends DurableObject {}

const NotAnActorContract = { name: "not-an-actor", def: {} };

export type JournalProbeState = {
  owner: string;
  createdAt: number;
  notes: { id: string; text: string; at: number; roll: number }[];
  connects: string[];
  disconnects: string[];
  results: unknown[];
  errors: string[];
  /** Keys of each received view (the view itself may not be JSON-safe). */
  linkViews: { id: string | undefined; keys: string[]; at: number }[];
  linkErrors: string[];
  unlinked: string[];
  migratedFrom: number;
};

const ProbeView = schema({ owner: string, notes: uint32 });

export const JOURNAL_PROBE_VERSION = 2;

const JournalProbeContract = defineActor("journal-probe", {
  version: JOURNAL_PROBE_VERSION,
  input: z.object({ owner: z.string() }),
  init: ({ owner }: { owner: string }, ctx: DeterministicContext): JournalProbeState => ({
    owner,
    createdAt: ctx.now(),
    notes: [],
    connects: [],
    disconnects: [],
    results: [],
    errors: [],
    linkViews: [],
    linkErrors: [],
    unlinked: [],
    migratedFrom: 0,
  }),
  migrate: (persisted: unknown, fromVersion: number) => ({
    ...z.looseObject({ owner: z.string() }).parse(persisted),
    migratedFrom: fromVersion,
  }),
  roles: { user: () => true },
  messages: {
    NOTE: message(z.object({ text: z.string().min(1) }), (state: JournalProbeState, { text }, ctx) => ({
      ...state,
      notes: [...state.notes, { id: ctx.id(), text, at: ctx.now(), roll: ctx.random() }],
    })),
    FETCH: message(z.object({ q: z.string() }), (state: JournalProbeState, { q }, ctx) => {
      ctx.execute("ECHO", { q });
      return state;
    }),
    FAIL: message(z.object({ q: z.string() }), (state: JournalProbeState, { q }, ctx) => {
      ctx.execute("BOOM", { q });
      return state;
    }),
    BIG: message(z.object({}), (state: JournalProbeState, _p: Record<string, never>, ctx) => {
      ctx.execute("BIGINT", {});
      return state;
    }),
    LINK: message(z.object({ id: z.string() }), (state: JournalProbeState, { id }, ctx) => {
      ctx.link("room", id);
      return state;
    }),
    UNLINK_ALL: message(z.object({}), (state: JournalProbeState, _p: Record<string, never>, ctx) => {
      ctx.unlink("room");
      return state;
    }),
  },
  lifecycle: {
    connect: (state: JournalProbeState, { caller }: { caller: string }, ctx: DeterministicContext) => ({
      ...state,
      connects: [...state.connects, `${caller}@${ctx.now()}`],
    }),
    disconnect: (state: JournalProbeState, { caller }: { caller: string }) => ({
      ...state,
      disconnects: [...state.disconnects, caller],
    }),
  },
  services: {
    ECHO: {
      fn: async (input: unknown) => ({ echo: input }),
      onDone: (state: JournalProbeState, result: unknown, _input: unknown, ctx: DeterministicContext) => ({
        ...state,
        results: [...state.results, { result, at: ctx.now() }],
      }),
    },
    BOOM: {
      fn: async (): Promise<unknown> => {
        throw new Error("boom");
      },
      onError: (state: JournalProbeState, error: { message: string }) => ({
        ...state,
        errors: [...state.errors, error.message],
      }),
    },
    // The result can't be stored as JSON, so persisting this transition fails.
    BIGINT: {
      fn: async () => 10n,
      onDone: (state: JournalProbeState) => ({ ...state, results: [...state.results, "big"] }),
    },
  },
  links: {
    room: link(NotAnActorContract, {
      onUpdate: (state: JournalProbeState, view: unknown, id: string | undefined, ctx: DeterministicContext) => ({
        ...state,
        linkViews: [...state.linkViews, { id, keys: Object.keys(view ?? {}).sort(), at: ctx.now() }],
      }),
      onError: (state: JournalProbeState, error: { message: string; code: string }, id?: string) => ({
        ...state,
        linkErrors: [...state.linkErrors, `${id}:${error.code}`],
      }),
      onUnlink: (state: JournalProbeState, id?: string) => ({
        ...state,
        unlinked: [...state.unlinked, id ?? "?"],
      }),
    }),
  },
  views: {
    user: view.shared(ProbeView, (state: JournalProbeState) => ({ owner: state.owner, notes: state.notes.length })),
  },
});

export const JournalProbe = createActorClass(JournalProbeContract);

// --- JournalOff: journal: false ---

type Count = { count: number };
const CountView = schema({ count: uint32 });

const inc = message(z.object({}), (state: Count) => ({ count: state.count + 1 }));

export const JournalOff = createActorClass(
  defineActor("journal-off", {
    input: z.object({}),
    init: (): Count => ({ count: 0 }),
    roles: { user: () => true },
    messages: { INC: inc },
    views: { user: view.shared(CountView, (s: Count) => s) },
    journal: false,
  }),
);

// --- JournalKeep: pruning ---

export const JournalKeep = createActorClass(
  defineActor("journal-keep", {
    input: z.object({}),
    init: (): Count => ({ count: 0 }),
    roles: { user: () => true },
    messages: { INC: inc },
    views: { user: view.shared(CountView, (s: Count) => s) },
    journal: { keep: 3, checkpointEvery: 2 },
  }),
);
