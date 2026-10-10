/**
 * The outbound event stream in a real Durable Object (ADR-017 §3): a published event becomes an
 * outbox row under its effect id, sent to the Queue binding after commit. A queue that is not
 * bound fails the try, which retries (and dead-letters after the last try) like any effect.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const Row = z.object({
  id: z.string(),
  service: z.string(),
  status: z.string(),
  payload: z.string(),
  last_error: z.string().nullable(),
});

async function rows(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql
      .exec("SELECT id, service, status, payload, last_error FROM executions ORDER BY seq, idx")
      .toArray()
      .map((r) => Row.parse(r)),
  );
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return read();
}

describe("publish", () => {
  it("sends each published event to the queue under its effect id", async () => {
    const id = `lot-${Date.now()}`;
    const stub = env.LOT.get(env.LOT.idFromName(id));
    await stub.spawn({ actorId: id, caller: "u", callerType: "user", input: {} });
    await stub.send("u", "user", { type: "PLACE", n: 3 });
    const sent = await until(
      () => rows(stub),
      (r) => r[0]?.status === "done",
    );
    expect(sent.map((r) => [r.id, r.service, r.status])).toEqual([["2:1", "__publish", "done"]]);
    expect(JSON.parse(sent[0]?.payload ?? "null")).toMatchObject({
      actorType: "lot",
      actorId: id,
      seq: 2,
      index: 1,
      name: "Placed",
      payload: { n: 3 },
      causationId: `lot/${id}/2`,
      correlationId: `lot/${id}/2`,
      idempotencyKey: `lot/${id}/2:1`,
    });
  });

  it("a queue that is not bound retries the row with the reason", async () => {
    const id = `lot-unbound-${Date.now()}`;
    const stub = env.LOT_UNBOUND.get(env.LOT_UNBOUND.idFromName(id));
    await stub.spawn({ actorId: id, caller: "u", callerType: "user", input: {} });
    await stub.send("u", "user", { type: "PLACE", n: 1 });
    const tried = await until(
      () => rows(stub),
      (r) => r[0]?.status === "retrying",
    );
    expect(tried.map((r) => [r.id, r.status, r.last_error])).toEqual([
      ["2:1", "retrying", 'Queue binding "MISSING_QUEUE" is not bound'],
    ]);
  });

  it("a queue failure is a Defect, retried by the default rule like a service's (ADR-016 §2)", async () => {
    const id = `lot-unbound-tag-${Date.now()}`;
    const stub = env.LOT_UNBOUND.get(env.LOT_UNBOUND.idFromName(id));
    await stub.spawn({ actorId: id, caller: "u", callerType: "user", input: {} });
    await stub.send("u", "user", { type: "PLACE", n: 1 });
    const tried = await until(
      () => tagged(stub),
      (r) => r[0]?.status === "retrying",
    );
    expect(tried).toEqual([{ id: "2:1", status: "retrying", attempts: 1, last_error_tag: "Defect" }]);
  });

  it("with a typed env, the queue binding is the parsed env's (ADR-016 §4)", async () => {
    const id = `lot-typed-${Date.now()}`;
    const stub = env.LOT_TYPED.get(env.LOT_TYPED.idFromName(id));
    await stub.spawn({ actorId: id, caller: "u", callerType: "user", input: {} });
    await stub.send("u", "user", { type: "PLACE", n: 4 });
    const sent = await until(
      () => rows(stub),
      (r) => r[0]?.status === "done",
    );
    expect(sent.map((r) => [r.id, r.service, r.status])).toEqual([["2:1", "__publish", "done"]]);
    expect(JSON.parse(sent[0]?.payload ?? "null")).toMatchObject({
      actorType: "lot-typed",
      name: "Placed",
      payload: { n: 4 },
      idempotencyKey: `lot-typed/${id}/2:1`,
    });
  });
});

const TaggedRow = z.object({
  id: z.string(),
  status: z.string(),
  attempts: z.number(),
  last_error_tag: z.string().nullable(),
});

async function tagged(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql
      .exec("SELECT id, status, attempts, last_error_tag FROM executions ORDER BY seq, idx")
      .toArray()
      .map((r) => TaggedRow.parse(r)),
  );
}
