/**
 * Causation and correlation ids across real Durable Objects (ADR-017 §4): a message starts a
 * flow; its service result, the forwards it sends and the link pushes its changes cause carry the
 * flow on, caused by the effect (or, for a push, the source's event). Studio's timeline shows them.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { type JournalEvent, readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

async function journal(stub: DurableObjectStub): Promise<JournalEvent[]> {
  return runInDurableObject(stub, (_i, state) => readJournal(state.storage.sql).events);
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return read();
}

const ids = (events: JournalEvent[]) => events.map((e) => [e.seq, e.causeType, e.correlationId, e.causationId]);

describe("ids across actors", () => {
  it("a message starts a flow; its service result continues it, caused by the execution", async () => {
    const id = unique("trace-desk");
    const desk = env.DESK.get(env.DESK.idFromName(id));
    await desk.spawn({ actorId: id, caller: "u", callerType: "user", input: {} });
    await desk.send("u", "user", { type: "RUN", tag: "a", delayMs: 0, fail: false });
    const events = await until(
      () => journal(desk),
      (e) => e.length >= 3,
    );
    expect(ids(events)).toEqual([
      // An actor that can auto-spawn is created (under its hex id) before spawn() names it.
      [1, "init", expect.stringMatching(/^desk\/[0-9a-f]{64}\/1$/), undefined],
      [2, "message", `desk/${id}/2`, undefined],
      [3, "service.onDone", `desk/${id}/2`, `desk/${id}/2:0`],
    ]);
  });

  it("a forward carries the flow to the target; a link push carries the source's flow back", async () => {
    const bid = unique("trace-bulletin");
    const bulletin = env.BULLETIN.get(env.BULLETIN.idFromName(bid));
    await bulletin.spawn({ actorId: bid, caller: "u", callerType: "user", input: { headline: "a" } });
    const did = unique("trace-desk");
    const desk = env.DESK.get(env.DESK.idFromName(did));
    await desk.spawn({ actorId: did, caller: "u", callerType: "user", input: {} });
    await desk.send("u", "user", { type: "FOLLOW", id: bid }); // desk seq 2
    await until(
      () => journal(desk),
      (e) => e.length >= 3,
    ); // the bulletin pushes its view (after its seq 1)
    await desk.send("u", "user", { type: "SHOUT", id: bid, headline: "b" }); // desk seq 4 forwards EDIT

    const edited = await until(
      () => journal(bulletin),
      (e) => e.length >= 2,
    );
    expect(ids(edited).at(-1)).toEqual([2, "message", `desk/${did}/4`, `desk/${did}/4:0`]);

    const pushed = await until(
      () => journal(desk),
      (e) => e.length >= 5,
    );
    expect(ids(pushed).filter(([, cause]) => cause === "link.onUpdate")).toEqual([
      [3, "link.onUpdate", `bulletin/${bid}/1`, `bulletin/${bid}/1`],
      [5, "link.onUpdate", `desk/${did}/4`, `bulletin/${bid}/2`],
    ]);

    const { entries } = await desk.__getTimeline({ limit: 1 });
    expect(entries[0]).toMatchObject({ correlationId: `desk/${did}/4`, causationId: `bulletin/${bid}/2` });
  });

  it("send() metadata that is not a trace starts a new flow", async () => {
    const bid = unique("trace-bulletin");
    const bulletin = env.BULLETIN.get(env.BULLETIN.idFromName(bid));
    await bulletin.spawn({ actorId: bid, caller: "u", callerType: "user", input: { headline: "a" } });
    const send: (...args: unknown[]) => Promise<unknown> = bulletin.send;
    await Reflect.apply(send, bulletin, ["u", "user", { type: "EDIT", headline: "x" }, { correlationId: "" }]);
    expect(ids(await journal(bulletin)).at(-1)).toEqual([2, "message", `bulletin/${bid}/2`, undefined]);
  });
});
