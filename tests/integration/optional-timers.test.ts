/**
 * Optional and nullable timer payloads in a Durable Object (Catancast, 2026-10-18): a timer
 * scheduled without a payload fires with the payload simulate() gives it, instead of being
 * dropped with actor_kit.timer.failed "expected object, received null".
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { replayJournal } from "@actor-kit/test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OptionalTimersContract } from "./src/optional-timers";

let n = 0;
const State = z.object({ fired: z.array(z.object({ name: z.string(), payload: z.string() })) });

async function fire(name: string, payload?: unknown) {
  const id = `optional-${Date.now()}-${++n}`;
  const stub = env.OPTIONAL_TIMERS.get(env.OPTIONAL_TIMERS.idFromName(id));
  await stub.spawn({ actorId: id, caller: "svc", callerType: "service", input: {} });
  const sent: unknown = await stub.send("p", "user", {
    type: "LATER",
    name,
    inMs: 60_000,
    ...(payload === undefined ? {} : { payload }),
  });
  expect(sent).toMatchObject({ ok: true });
  await runInDurableObject(stub, async (_i, state) => {
    state.storage.sql.exec("UPDATE timers SET fire_at = fire_at - 3600000");
    await state.storage.setAlarm(Date.now());
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await runDurableObjectAlarm(stub);
  const logged = errors.mock.calls.map((call) => String(call[0]));
  errors.mockRestore();
  const look = await runInDurableObject(stub, (_i, state) => ({
    state: State.parse(JSON.parse(String(state.storage.sql.exec("SELECT state FROM snapshots").one()["state"]))),
    timers: state.storage.sql.exec("SELECT id FROM timers").toArray().length,
    journal: readJournal(state.storage.sql),
  }));
  return { ...look, logged };
}

describe("timers with an optional or nullable payload, in a Durable Object", () => {
  it.each([
    ["bot", undefined, "undefined"],
    ["bot", {}, "{}"],
    ["maybe", null, "null"],
    ["nullish", undefined, "null"],
    ["plain", undefined, "undefined"],
  ])("%s scheduled with %j fires, and its handler sees %s (as in simulate)", async (name, payload, expected) => {
    const { state, timers, logged } = await fire(name, payload);
    expect(logged.filter((line) => line.includes("timer.failed"))).toEqual([]);
    expect(state.fired).toEqual([{ name, payload: expected }]);
    expect(timers).toBe(0);
  });

  it("the journal of a payload-less firing replays to the same state", async () => {
    const { state, journal } = await fire("bot");
    await expect(replayJournal(OptionalTimersContract, journal)).resolves.toMatchObject({ state });
  });
});
