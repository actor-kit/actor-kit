/**
 * Scoped invocations (ADR-019 B), shared by the unit and integration tests: `loading` looks an answer up
 * with a call scoped to itself, so leaving it aborts the call and a late result goes to `onStale`
 * (`lookup`) or is only journaled (`audit`, no onStale). `round` owns a call while its children change.
 * The services wait `ms` and ignore the abort, so a late result really arrives in the Durable Object.
 */
import { setup } from "@actor-kit/worker/testing";
import { z } from "zod";

export type Shared = { log: string[] };

const note = (s: Shared, line: string): Shared => ({ log: [...s.log, line] });

const Wait = z.object({ q: z.string(), ms: z.number() });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const calls = setup({
  events: { Stale: z.object({ effectId: z.string() }) },
  states: {
    idle: {},
    loading: { local: z.object({ q: z.string() }), input: Wait },
    ready: { local: z.object({ answer: z.string() }), input: z.object({ answer: z.string() }) },
    round: { states: { a: {}, b: {} } },
  },
});

const idle = calls.in("idle");
const loading = calls.in("loading");
const round = calls.in("round");

export const ScopedCalls = calls.actor("scoped-calls", {
  input: z.object({}),
  init: (): Shared => ({ log: [] }),
  roles: { any: () => true },
  initial: "idle",
  messages: {
    // Not scoped: no state owns it, so its result reaches onDone wherever the actor is.
    FREE: calls.message(z.object({ q: z.string() }), (s: Shared, { q }, ctx) => {
      ctx.execute("lookup", { q, ms: 0 });
      return s;
    }),
  },
  services: {
    lookup: calls.service({
      result: z.object({ answer: z.string(), aborted: z.boolean() }),
      fn: async (input, _env, effect) => {
        const { q, ms } = Wait.parse(input);
        await sleep(ms);
        return { answer: q, aborted: effect.signal.aborted };
      },
      // A callback runs at the level that owns its call and may goto (the saga recipe needs it).
      onDone: (s: Shared, result, _input, ctx) =>
        ctx.goto("ready", note(s, `done ${result.answer} in ${ctx.phase.join(".")}`), { answer: result.answer }),
      onError: (s: Shared, error) => note(s, `error ${error._tag}`),
      onStale: (s: Shared, result, _input, ctx) => {
        ctx.emit("Stale", { effectId: ctx.effectId });
        return note(s, `stale ${result.answer} aborted=${String(result.aborted)} in ${ctx.phase.join(".")}`);
      },
    }),
    audit: calls.service({
      fn: async (input) => {
        await sleep(Wait.pick({ ms: true }).parse(input).ms);
        return { ok: true };
      },
      onDone: (s: Shared) => note(s, "audited"),
    }),
  },
  states: {
    idle: idle.state({
      messages: {
        LOAD: idle.message(Wait, (s: Shared, input, ctx) => ctx.goto("loading", s, input)),
        ROUND: idle.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto("round", s)),
      },
    }),
    loading: loading.state({
      enter: (_s: Shared, { q, ms }, ctx) => {
        ctx.execute("lookup", { q, ms }, { scope: "state" });
        ctx.execute("audit", { ms }, { scope: "state" });
        return { q };
      },
      messages: {
        CANCEL: loading.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto("idle", s)),
      },
    }),
    ready: calls.in("ready").state({
      enter: (_s: Shared, { answer }) => ({ answer }),
      messages: { RESET: calls.in("ready").message(z.object({}), (s: Shared, _p, ctx) => ctx.goto("idle", s)) },
    }),
    round: round.state({
      initial: "a",
      enter: (s: Shared, _input, ctx) => {
        ctx.execute("audit", { ms: 0 }, { scope: "state" });
        return ctx.stay(s);
      },
      messages: { LEAVE: round.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto("idle", s)) },
      states: {
        a: calls.in(["round", "a"]).state({
          messages: {
            NEXT: calls.in(["round", "a"]).message(z.object({}), (s: Shared, _p, ctx) => ctx.goto(["round", "b"], s)),
          },
        }),
        b: calls.in(["round", "b"]).state({}),
      },
    }),
  },
  views: {},
});
