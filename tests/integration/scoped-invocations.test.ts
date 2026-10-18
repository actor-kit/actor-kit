/**
 * Scoped invocations in a real Durable Object (ADR-019 B): leaving the state that made a call aborts its
 * try (the service sees its AbortSignal aborted), the row ends `cancelled` with the stale reason, and the
 * late result is journaled as `service.stale` and handed to onStale; the journal replays.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { replayJournal } from "@actor-kit/test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { ScopedCalls } from "./src/nested-states";

type Stub = DurableObjectStub;

const state = (stub: Stub) =>
  runInDurableObject(stub, (_i, s) =>
    JSON.parse(String(s.storage.sql.exec("SELECT state FROM snapshots").one()["state"])),
  );

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return read();
}

async function spawn(name: string): Promise<Stub> {
  const id = `${name}-${Date.now()}`;
  const stub = env.SCOPED_CALLS.get(env.SCOPED_CALLS.idFromName(id));
  await stub.spawn({ actorId: id, caller: "host", callerType: "service", input: {} });
  return stub;
}

describe("scoped calls in a Durable Object", () => {
  it("a result in time runs onDone at the owning state, which moves on", async () => {
    const stub = await spawn("scoped-done");
    await stub.send("u", "user", { type: "LOAD", q: "x", ms: 0 });
    const done = await until(
      () => state(stub),
      (s) => Array.isArray(s.phase) && s.phase[0] === "ready",
    );
    expect(done).toMatchObject({ phase: ["ready"], locals: [{ answer: "x" }], shared: { log: ["done x in loading"] } });
  });

  it("leaving the state aborts the call; its late result goes to onStale and is journaled", async () => {
    const stub = await spawn("scoped-stale");
    // 1 s, not 150 ms: under a full parallel run the CANCEL below arrived after a 150 ms call had
    // already finished (row "done", not "cancelled"). The late result still lands within until().
    await stub.send("u", "user", { type: "LOAD", q: "late", ms: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 30)); // the tries are in flight
    await stub.send("u", "user", { type: "CANCEL" });
    const rows = await runInDurableObject(stub, (_i, s) =>
      s.storage.sql.exec("SELECT service, status, last_error FROM executions ORDER BY seq, idx").toArray(),
    );
    const attempts = await runInDurableObject(stub, (_i, s) =>
      s.storage.sql.exec("SELECT attempts FROM executions ORDER BY seq, idx").toArray(),
    );
    expect(attempts).toEqual([{ attempts: 1 }, { attempts: 0 }]);
    expect(rows).toEqual([
      {
        service: "lookup",
        status: "cancelled",
        last_error: "cancelled: the state that made the call was left (a late result goes to onStale)",
      },
      {
        service: "audit",
        status: "cancelled",
        last_error: "cancelled: the state that made the call was left (a late result goes to onStale)",
      },
    ]);
    // lookup was in flight, so its late result arrives; audit (run one at a time) never started.
    const journal = await until(
      () => runInDurableObject(stub, (_i, s) => readJournal(s.storage.sql)),
      (j) => j.events.some((e) => e.causeType === "service.stale"),
    );
    expect(journal.events.filter((e) => e.causeType === "service.stale").map((e) => e.name)).toEqual(["lookup"]);
    const after = await state(stub);
    expect(after.phase).toEqual(["idle"]);
    expect(after.shared.log[0]).toMatch(/^stale late aborted=true in idle$/);
    await replayJournal(ScopedCalls, journal);
  });
});
