/**
 * States with typed locals in a real Durable Object (ADR-017 §1), on the quiz example: phases and
 * locals persist, a scope:"state" timer fires on the alarm, leaving early cancels it, wrong-phase
 * messages are refused with wrong_state, the journal replays, Studio sees the phase.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { replayJournal } from "@actor-kit/test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { QuizContract } from "./src/quiz-states";

async function spawn(name: string) {
  const id = `${name}-${Date.now()}`;
  const stub = env.QUIZ_STATES.get(env.QUIZ_STATES.idFromName(id));
  await stub.spawn({ actorId: id, caller: "host", callerType: "service", input: {} });
  await stub.send("ann", "user", { type: "JOIN" });
  return stub;
}

const state = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (_i, s) => {
    const row = s.storage.sql.exec("SELECT state FROM snapshots WHERE id = 1").one();
    return JSON.parse(String(row["state"]));
  });

describe("quiz in a Durable Object", () => {
  it("a round's state timer fires on the alarm and moves to reveal", async () => {
    const stub = await spawn("states-timer");
    expect(await stub.send("ann", "user", { type: "ANSWER", text: "42" })).toMatchObject({
      ok: false,
      code: "wrong_state",
    });
    await stub.send("ann", "user", { type: "START" });
    await stub.send("ann", "user", { type: "ANSWER", text: "42" });
    expect(await state(stub)).toMatchObject({
      phase: ["round"],
      locals: [{ n: 1, answers: { ann: "42" } }],
      stateTimers: [["round:roundEnd"]],
    });
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec("UPDATE timers SET fire_at = 0");
    });
    await runDurableObjectAlarm(stub);
    expect(await state(stub)).toEqual({
      shared: { players: ["ann"], scores: { ann: 1 } },
      phase: ["reveal"],
      locals: [null],
      stateTimers: [[]],
    });
    const journal = await runInDurableObject(stub, (_i, s) => readJournal(s.storage.sql));
    await replayJournal(QuizContract, journal);
    const { entries } = await stub.__getTimeline({ limit: 1 });
    expect(JSON.parse(entries[0]?.stateSnapshot ?? "null")).toMatchObject({ phase: ["reveal"] });
  });

  it("ending the round early cancels its timer", async () => {
    const stub = await spawn("states-early");
    await stub.send("ann", "user", { type: "START" });
    await stub.send("host", "service", { type: "END" });
    const timers = await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("SELECT key FROM timers").toArray());
    expect(timers).toEqual([]);
    expect(await state(stub)).toMatchObject({ phase: ["reveal"], locals: [null] });
  });
});
