/**
 * Actors used by the studio instrumentation integration tests
 * (tests/integration/studio-instrumentation.test.ts).
 *
 * StudioProbe exercises every timeline cause the runtime can produce:
 * init, migrate, message, lifecycle.connect / lifecycle.disconnect,
 * service.onDone / service.onError. It has a tiny timeline (5 entries),
 * no catch-all role, a shared view and a perCaller view.
 *
 * StudioOff opts out of studio instrumentation with `studio: { enabled: false }`,
 * even though STUDIO_REGISTRY is bound in this Worker.
 */

import { schema, string, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, message } from "@actor-kit/worker";
import { z } from "zod";

export type ProbeState = {
  owner: string;
  count: number;
  connects: number;
  disconnects: number;
  lastResult: string;
  migratedFrom: number;
};

const ProbeAdminView = schema({ count: uint32, connects: uint32, disconnects: uint32, lastResult: string });
const ProbeMemberView = schema({ count: uint32, viewer: string, isOwner: string });

export const PROBE_TIMELINE_SIZE = 5;
export const PROBE_VERSION = 2;

const StudioProbeContract = defineActor("studio-probe", {
  version: PROBE_VERSION,
  // Required input: the actor stays uninitialised (empty timeline) until spawn().
  input: z.object({ owner: z.string() }),
  init: ({ owner }: { owner: string }): ProbeState => ({
    owner,
    count: 0,
    connects: 0,
    disconnects: 0,
    lastResult: "",
    migratedFrom: 0,
  }),
  migrate: (persisted: unknown, fromVersion: number): ProbeState => {
    const v1 = z.object({ owner: z.string(), count: z.number() }).parse(persisted);
    return { ...v1, connects: 0, disconnects: 0, lastResult: "", migratedFrom: fromVersion };
  },
  roles: {
    admin: (_state: ProbeState, _caller: string, { callerType }: { callerType: "user" | "service" }) =>
      callerType === "service",
    member: (_state: ProbeState, caller: string) => caller.startsWith("member-"),
    // No catch-all: any other caller is rejected.
  },
  lifecycle: {
    connect: (state: ProbeState) => ({ ...state, connects: state.connects + 1 }),
    disconnect: (state: ProbeState) => ({ ...state, disconnects: state.disconnects + 1 }),
  },
  services: {
    OK_SVC: {
      fn: async (input: { tag: string }) => ({ echoed: input.tag }),
      onDone: (state: ProbeState, result: { echoed: string }) => ({ ...state, lastResult: `done:${result.echoed}` }),
    },
    FAIL_SVC: {
      fn: async (input: { tag: string }): Promise<never> => {
        throw new Error(`boom:${input.tag}`);
      },
      onError: (state: ProbeState, error: { message: string }) => ({ ...state, lastResult: `error:${error.message}` }),
    },
  },
  messages: {
    INCREMENT: message(z.object({ amount: z.number().int().positive() }), (state: ProbeState, { amount }) => ({
      ...state,
      count: state.count + amount,
    })),
    RUN_OK: message(
      z.object({ tag: z.string() }),
      (state: ProbeState, { tag }, ctx: { execute: (service: string, input: unknown) => void }) => {
        ctx.execute("OK_SVC", { tag });
        return state;
      },
    ),
    RUN_FAIL: message(
      z.object({ tag: z.string() }),
      (state: ProbeState, { tag }, ctx: { execute: (service: string, input: unknown) => void }) => {
        ctx.execute("FAIL_SVC", { tag });
        return state;
      },
    ),
  },
  views: {
    admin: view.shared(ProbeAdminView, (state: ProbeState) => ({
      count: state.count,
      connects: state.connects,
      disconnects: state.disconnects,
      lastResult: state.lastResult,
    })),
    member: view.perCaller(ProbeMemberView, (state: ProbeState, caller: string) => ({
      count: state.count,
      viewer: caller,
      isOwner: caller === state.owner ? "yes" : "no",
    })),
  },
  studio: { timelineSize: PROBE_TIMELINE_SIZE },
});

export const StudioProbe = createActorClass(StudioProbeContract);

const StudioOffContract = defineActor("studio-off", {
  input: z.object({}),
  init: () => ({ count: 0 }),
  roles: { user: () => true },
  messages: {
    INCREMENT: message(z.object({}), (state: { count: number }) => ({ count: state.count + 1 })),
  },
  views: {
    user: view.shared(schema({ count: uint32 }), (state: { count: number }) => ({ count: state.count })),
  },
  studio: { enabled: false },
});

export const StudioOff = createActorClass(StudioOffContract);
