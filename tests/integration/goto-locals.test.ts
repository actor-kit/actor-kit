/**
 * ADR-019 A rows 21-23 in a real Durable Object (Run Set Jimmy feedback 14): a goto that changes the kept
 * round as it switches window ⇄ acting persists both, the journal replays, and `__restore` to a seq
 * before a move gives back the round and the child the actor had there.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { replayJournal } from "@actor-kit/test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { RoundLocals } from "./src/nested-states";

type Stub = DurableObjectStub;

const state = (stub: Stub) =>
  runInDurableObject(stub, (_i, s) => {
    const row = s.storage.sql.exec("SELECT state FROM snapshots WHERE id = 1").one();
    return JSON.parse(String(row["state"]));
  });

describe("goto with kept locals in a Durable Object", () => {
  it("persists the kept round with the new child, replays, and restores to an earlier move", async () => {
    const id = `round-locals-${Date.now()}`;
    const stub = env.ROUND_LOCALS.get(env.ROUND_LOCALS.idFromName(id));
    await stub.spawn({ actorId: id, caller: "host", callerType: "service", input: {} });
    await stub.send("ann", "user", { type: "START" }); // seq 2
    expect(await state(stub)).toMatchObject({
      phase: ["playing", "window"],
      locals: [{ round: 1, moves: 0, windows: 1 }, { buys: [] }],
    });
    expect(await stub.send("ann", "user", { type: "ACT" })).toEqual({ ok: true }); // seq 3
    const acting = await state(stub);
    expect(acting).toMatchObject({
      phase: ["playing", "acting"],
      locals: [{ round: 1, moves: 1, windows: 1 }, { actor: "ann" }],
    });
    await stub.send("ann", "user", { type: "DONE" }); // seq 4
    expect(await state(stub)).toMatchObject({
      phase: ["playing", "window"],
      locals: [{ round: 1, moves: 2, windows: 2 }, { buys: [] }],
    });

    const journal = await runInDurableObject(stub, (_i, s) => readJournal(s.storage.sql));
    expect((await replayJournal(RoundLocals, journal)).state).toEqual(await state(stub));

    expect(await stub.__restore({ toSeq: 3 })).toEqual({ ok: true });
    expect(await state(stub)).toEqual(acting);
    expect(await stub.send("ann", "user", { type: "DONE" })).toEqual({ ok: true });
    expect(await state(stub)).toMatchObject({ locals: [{ moves: 2, windows: 2 }, { buys: [] }] });
  });
});
