/**
 * Hierarchical states in a real Durable Object (ADR-019 A): the path, the per-level locals and the
 * per-level timers persist; a child's scoped timer and the parent's both fire on the alarm; the journal
 * replays; and an actor stored in the 0.2 flat shape is read as its one-element path on load.
 */
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { replayJournal } from "@actor-kit/test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { Rounds } from "./src/nested-states";
import { QuizContract } from "./src/quiz-states";

type Stub = DurableObjectStub;

const state = (stub: Stub) =>
  runInDurableObject(stub, (_i, s) => {
    const row = s.storage.sql.exec("SELECT state FROM snapshots WHERE id = 1").one();
    return JSON.parse(String(row["state"]));
  });

/** Fire the soonest timer: move every deadline to now, then run the alarm. */
async function fireDue(stub: Stub, key: string) {
  await runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec("UPDATE timers SET fire_at = 0 WHERE key = ?", key);
  });
  await runDurableObjectAlarm(stub);
}

describe("nested states in a Durable Object", () => {
  it("persists the path, a local and a timer list per level; child and parent timers fire on the alarm", async () => {
    const id = `rounds-${Date.now()}`;
    const stub = env.ROUNDS.get(env.ROUNDS.idFromName(id));
    await stub.spawn({ actorId: id, caller: "host", callerType: "service", input: {} });
    expect(await stub.send("ann", "user", { type: "START", round: 1 })).toEqual({ ok: true });
    await stub.send("ann", "user", { type: "BUY" });
    expect(await state(stub)).toEqual({
      shared: { log: ["exit lobby", "enter playing 1", "enter window 1"] },
      phase: ["playing", "window"],
      locals: [{ round: 1 }, { buys: ["ann"] }],
      stateTimers: [["playing:tick"], ["playing.window:close"]],
    });

    await fireDue(stub, "playing.window:close"); // the window's timer: goto acting
    expect(await state(stub)).toMatchObject({
      phase: ["playing", "acting"],
      locals: [{ round: 1 }, { actor: "timeout" }],
      stateTimers: [["playing:tick"], []],
    });
    await fireDue(stub, "playing:tick"); // the parent's timer fires while a child is active
    expect(await state(stub)).toMatchObject({ phase: ["playing", "acting"], stateTimers: [[], []] });
    expect((await state(stub)).shared.log.at(-1)).toBe("tick 1");

    await stub.send("ann", "user", { type: "END" });
    const timers = await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("SELECT key FROM timers").toArray());
    expect(timers).toEqual([]);
    const journal = await runInDurableObject(stub, (_i, s) => readJournal(s.storage.sql));
    await replayJournal(Rounds, journal);
  });

  it("refuses a message of another branch with wrong_state, naming dotted paths", async () => {
    const id = `rounds-refuse-${Date.now()}`;
    const stub = env.ROUNDS.get(env.ROUNDS.idFromName(id));
    await stub.spawn({ actorId: id, caller: "host", callerType: "service", input: {} });
    await stub.send("ann", "user", { type: "START", round: 1 });
    expect(await stub.send("ann", "user", { type: "DONE" })).toMatchObject({
      ok: false,
      code: "wrong_state",
      message: "DONE is accepted in playing.acting; the actor is in playing.window.",
    });
  });
});

describe("0.2 persisted shape", () => {
  it("an actor stored with a flat phase name is read as its one-element path, and goes on", async () => {
    const id = `quiz-legacy-${Date.now()}`;
    const stub = env.QUIZ_STATES.get(env.QUIZ_STATES.idFromName(id));
    await stub.spawn({ actorId: id, caller: "host", callerType: "service", input: {} });
    await stub.send("ann", "user", { type: "JOIN" });
    await stub.send("ann", "user", { type: "START" });
    // Rewrite the snapshot as 0.2 stored it.
    await runInDurableObject(stub, (_i, s) => {
      const legacy = {
        shared: { players: ["ann"], scores: { ann: 0 } },
        phase: "round",
        local: { n: 1, answers: {} },
        stateTimers: ["round:roundEnd"],
      };
      s.storage.sql.exec("UPDATE snapshots SET state = ? WHERE id = 1", JSON.stringify(legacy));
    });
    await evictDurableObject(stub);
    expect(await stub.send("ann", "user", { type: "ANSWER", text: "42" })).toEqual({ ok: true });
    expect(await state(stub)).toEqual({
      shared: { players: ["ann"], scores: { ann: 0 } },
      phase: ["round"],
      locals: [{ n: 1, answers: { ann: "42" } }],
      stateTimers: [["round:roundEnd"]],
    });
    await stub.send("host", "service", { type: "END" });
    expect(await state(stub)).toMatchObject({ phase: ["reveal"], shared: { scores: { ann: 1 } } });
  });

  it("the loaded state is in the path shape before any transition (views and Studio see it)", async () => {
    const id = `quiz-legacy-view-${Date.now()}`;
    const stub = env.QUIZ_STATES.get(env.QUIZ_STATES.idFromName(id));
    await stub.spawn({ actorId: id, caller: "host", callerType: "service", input: {} });
    await runInDurableObject(stub, (_i, s) => {
      const legacy = { shared: { players: [], scores: {} }, phase: "lobby", local: null, stateTimers: [] };
      s.storage.sql.exec("UPDATE snapshots SET state = ? WHERE id = 1", JSON.stringify(legacy));
    });
    await evictDurableObject(stub);
    const inspect = await stub.__inspect();
    expect(inspect.state).toEqual({
      shared: { players: [], scores: {} },
      phase: ["lobby"],
      locals: [null],
      stateTimers: [[]],
    });
    expect(QuizContract.name).toBe("quiz");
  });
});
