/**
 * Restore (ADR-015 D3), the pure part: planRestore() folds the journal to `toSeq` from the newest
 * checkpoint at or before it (checksum-verified), rebuilds the timers pending at `toSeq` with their
 * original deadlines, and lists the service results recorded after `toSeq` for effects declared
 * at or before it (to redeliver, never to re-run). foldJournal() replays `restore` events.
 */
import { simulate } from "@actor-kit/test";
import {
  checksumState,
  defineActor,
  foldJournal,
  type Journal,
  type JournalEvent,
  message,
  planRestore,
  timer,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type S = { n: number; log: string[] };

const Shop = defineActor("shop", {
  input: z.object({}),
  init: (): S => ({ n: 0, log: [] }),
  roles: { any: () => true },
  messages: {
    INC: message(z.object({}), (s: S) => ({ ...s, n: s.n + 1 })),
    LATER: message(z.object({ inMs: z.number(), key: z.string() }), (s: S, { inMs, key }, ctx) => {
      ctx.schedule("ring", { in: inMs, key, payload: { key } });
      return s;
    }),
    STOP: message(z.object({ key: z.string() }), (s: S, { key }, ctx) => {
      ctx.cancel(key);
      return s;
    }),
    BUY: message(z.object({ item: z.string() }), (s: S, { item }, ctx) => {
      ctx.execute("PAY", { item });
      return s;
    }),
  },
  timers: {
    ring: timer(z.object({ key: z.string() }), (s: S, { key }, ctx) => ({
      ...s,
      log: [...s.log, `ring:${key}@${ctx.now()}`],
    })),
  },
  services: {
    PAY: {
      fn: async () => null,
      onDone: (s: S, result: unknown, input: unknown) => ({
        ...s,
        log: [...s.log, `paid:${JSON.stringify(input)}:${JSON.stringify(result)}`],
      }),
      onError: (s: S, e: { message: string }) => ({ ...s, log: [...s.log, `failed:${e.message}`] }),
    },
  },
  views: {},
  journal: { checkpointEvery: 3 },
});

/** The definition as the runtime holds it: flat messages nested under the role. */
const ShopDef = { ...Shop.def, messages: { any: Shop.def.messages } };

/** A shop journal written by the simulator: every transition through the runtime's step core. */
async function shop(
  script: (sim: ReturnType<typeof simulate>, send: (m: { type: string; [k: string]: unknown }) => void) => void,
) {
  const sim = simulate({ contracts: [Shop], now: 0 });
  const actor = await sim.spawn(Shop, "s1", {});
  const send = (m: { type: string; [k: string]: unknown }) => {
    actor.send("u", m);
  };
  script(sim, send);
  const journal = actor.journal;
  return { sim, actor, journal };
}

describe("planRestore: state", () => {
  it("is the fold to toSeq, from init or from the newest checkpoint at or before it", async () => {
    const { journal } = await shop((_sim, send) => {
      for (let i = 0; i < 7; i++) send({ type: "INC" });
    });
    expect(journal.checkpoints.map((c) => c.seq)).toEqual([3, 6]);
    for (const toSeq of [1, 2, 3, 4, 6, 8]) {
      const plan = await planRestore(ShopDef, journal, toSeq);
      expect(plan.state).toEqual({ n: toSeq - 1, log: [] });
    }
  });

  it("verifies the checkpoint it starts from", async () => {
    const { journal } = await shop((_sim, send) => {
      for (let i = 0; i < 7; i++) send({ type: "INC" });
    });
    const tampered: Journal = {
      events: journal.events,
      checkpoints: journal.checkpoints.map((c) =>
        c.seq === 6 ? { ...c, state: JSON.stringify({ n: 99, log: [] }) } : c,
      ),
    };
    await expect(planRestore(ShopDef, tampered, 7)).rejects.toThrow(/diverged at seq 6/);
    // An earlier target starts from the untouched checkpoint 3.
    expect((await planRestore(ShopDef, tampered, 5)).state).toEqual({ n: 4, log: [] });
  });

  it("refuses a seq outside the journal", async () => {
    const { journal } = await shop((_sim, send) => send({ type: "INC" }));
    for (const toSeq of [0, -1, 1.5, 3]) {
      await expect(planRestore(ShopDef, journal, toSeq)).rejects.toThrow(/Cannot restore to seq/);
    }
  });

  it("refuses a seq the pruned journal no longer covers", async () => {
    const { journal } = await shop((_sim, send) => {
      for (let i = 0; i < 7; i++) send({ type: "INC" });
    });
    const pruned: Journal = {
      events: journal.events.filter((e) => e.seq > 3),
      checkpoints: journal.checkpoints.filter((c) => c.seq >= 3),
    };
    expect((await planRestore(ShopDef, pruned, 5)).state).toEqual({ n: 4, log: [] });
    expect((await planRestore(ShopDef, pruned, 3)).state).toEqual({ n: 2, log: [] });
    await expect(planRestore(ShopDef, pruned, 2)).rejects.toThrow(/pruned/);
  });
});

describe("planRestore: timers", () => {
  it("rebuilds the timers pending at toSeq with their original ids and deadlines", async () => {
    const { journal } = await shop((sim, send) => {
      send({ type: "LATER", inMs: 1000, key: "a" }); // seq 2
      send({ type: "LATER", inMs: 3000, key: "b" }); // seq 3
      sim.advance(1500); // seq 4: a fires
      send({ type: "STOP", key: "b" }); // seq 5
      send({ type: "LATER", inMs: 10, key: "c" }); // seq 6
    });
    const at = async (toSeq: number) => (await planRestore(ShopDef, journal, toSeq)).timers;
    expect(await at(1)).toEqual([]);
    expect(await at(3)).toEqual([
      { id: "2:0", seq: 2, index: 0, name: "ring", key: "a", payload: { key: "a" }, fireAt: 1000 },
      { id: "3:0", seq: 3, index: 0, name: "ring", key: "b", payload: { key: "b" }, fireAt: 3000 },
    ]);
    expect((await at(4)).map((t) => t.key)).toEqual(["b"]);
    expect(await at(5)).toEqual([]);
    expect((await at(6)).map((t) => [t.key, t.fireAt])).toEqual([["c", 1510]]);
  });

  it("starts from the timers a checkpoint saved when the journal before it is pruned", async () => {
    const { journal } = await shop((_sim, send) => {
      send({ type: "LATER", inMs: 500, key: "a" }); // seq 2
      send({ type: "INC" }); // seq 3, checkpoint
      send({ type: "INC" }); // seq 4
    });
    const pruned: Journal = { events: journal.events.filter((e) => e.seq > 3), checkpoints: journal.checkpoints };
    expect((await planRestore(ShopDef, pruned, 4)).timers.map((t) => t.key)).toEqual(["a"]);
  });
});

describe("planRestore: recorded results", () => {
  it("lists results recorded after toSeq for effects declared at or before it, oldest first", async () => {
    const { sim, journal } = await shop((s, send) => {
      send({ type: "BUY", item: "x" }); // seq 2, effect 2:0
      send({ type: "BUY", item: "y" }); // seq 3, effect 3:0
      send({ type: "INC" }); // seq 4
      s.resolve("3:0", "r-y"); // seq 5
      s.reject("2:0", "declined"); // seq 6
      send({ type: "BUY", item: "z" }); // seq 7, effect 7:0
      s.resolve("7:0", "r-z"); // seq 8
    });
    expect(sim.pendingEffects()).toEqual([]);
    const plan = await planRestore(ShopDef, journal, 4);
    expect(plan.state).toEqual({ n: 1, log: [] });
    expect(plan.redeliver.map((e) => [e.seq, e.causeType, e.payload])).toEqual([
      [5, "service.onDone", { input: { item: "y" }, result: "r-y", effectId: "3:0" }],
      [6, "service.onError", { input: { item: "x" }, error: { message: "declined" }, effectId: "2:0" }],
    ]);
    expect((await planRestore(ShopDef, journal, 2)).redeliver.map((e) => e.seq)).toEqual([6]);
    expect((await planRestore(ShopDef, journal, 8)).redeliver).toEqual([]);
  });

  it("redelivers each effect's result once, and skips results without an effect id", async () => {
    const { journal } = await shop((s, send) => {
      send({ type: "BUY", item: "x" }); // seq 2
      s.resolve("2:0", "first"); // seq 3
    });
    const [, , done] = journal.events;
    if (done === undefined) throw new Error("missing event");
    const withCopies: Journal = {
      checkpoints: journal.checkpoints,
      events: [
        ...journal.events,
        { ...done, seq: 4, payload: { input: { item: "x" }, result: "copy", effectId: "2:0" } },
        { ...done, seq: 5, payload: { input: { item: "x" }, result: "legacy" } },
      ],
    };
    // Checksums of the appended copies are not verified (they come after toSeq).
    const plan = await planRestore(ShopDef, withCopies, 2);
    expect(plan.redeliver.map((e) => e.seq)).toEqual([3]);
  });
});

describe("foldJournal: restore events", () => {
  it("a restore event puts the state (and timers) back to its toSeq; later events build on it", async () => {
    const { journal } = await shop((_sim, send) => {
      send({ type: "INC" }); // seq 2: n = 1
      send({ type: "INC" }); // seq 3: n = 2
    });
    const restored = { n: 1, log: [] };
    const events: JournalEvent[] = [
      ...journal.events,
      {
        seq: 4,
        causeType: "restore",
        name: null,
        payload: { toSeq: 2 },
        caller: null,
        callerType: null,
        role: null,
        facts: {},
        codeVersion: 1,
        stateChecksum: checksumState(Shop.def, restored),
        createdAt: 0,
      },
      {
        seq: 5,
        causeType: "message",
        name: "INC",
        payload: {},
        caller: "u",
        callerType: "user",
        role: "any",
        facts: {},
        codeVersion: 1,
        stateChecksum: checksumState(Shop.def, { n: 2, log: [] }),
        createdAt: 0,
      },
    ];
    expect(await foldJournal(ShopDef, { events, checkpoints: [] })).toEqual({ state: { n: 2, log: [] }, replayed: 5 });
    expect((await planRestore(ShopDef, { events, checkpoints: [] }, 4)).state).toEqual(restored);
  });

  it("refuses a restore event whose target is not in the replayed journal", async () => {
    const { journal } = await shop((_sim, send) => send({ type: "INC" }));
    const restore: JournalEvent = {
      seq: 3,
      causeType: "restore",
      name: null,
      payload: { toSeq: 9 },
      caller: null,
      callerType: null,
      role: null,
      facts: {},
      codeVersion: 1,
      stateChecksum: "x",
      createdAt: 0,
    };
    await expect(foldJournal(ShopDef, { events: [...journal.events, restore], checkpoints: [] })).rejects.toThrow(
      /restores to seq 9/,
    );
  });
});
