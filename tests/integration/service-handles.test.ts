/**
 * ADR-018 G in a Durable Object: ctx.execute() returns the effect id, ctx.cancel(effectId) aborts the call
 * and discards its late result, `result` schemas (only the parsed value journaled, audit facts beside it),
 * at-most-once tries cut off by an eviction become OutcomeUnknown dead letters, and an at-least-once try
 * lost to eviction is an Evicted attempt.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

async function spawn(prefix: string) {
  const name = unique(prefix);
  const stub = env.CASHIER.get(env.CASHIER.idFromName(name));
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
  return stub;
}

type Stub = Awaited<ReturnType<typeof spawn>>;

const Row = z.object({
  id: z.string(),
  status: z.string(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  lastErrorTag: z.string().optional(),
});
const Inspect = z.object({
  state: z.object({ ids: z.array(z.string()), log: z.array(z.string()) }),
  outbox: z.array(Row),
});

async function inspect(stub: Stub) {
  return Inspect.parse(await stub.__inspect());
}

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Simulate an eviction mid-try: the row is left running and the next request wakes the actor. */
async function evictWhileRunning(stub: Stub) {
  await runInDurableObject(stub, (instance, s) => {
    s.storage.sql.exec("UPDATE executions SET status = 'running'");
    instance.persistedLoaded = false;
  });
  await stub.getSnapshot("u", "user");
}

describe("service handles in a Durable Object (ADR-018 G)", () => {
  it("ctx.execute returns the effect id the outbox row has", async () => {
    const stub = await spawn("id");
    await stub.send("u", "user", { type: "BUY", service: "CHARGE" });
    const done = await waitFor(
      () => inspect(stub),
      (i) => i.state.log.length === 1,
    );
    expect(done.state.ids).toEqual(["2:0"]);
    expect(done.outbox).toMatchObject([{ id: "2:0", status: "done" }]);
    expect(done.state.log).toEqual(['done 2:0 {"receipt":"r-1"}']);
  });

  it("journals only the parsed result, with the try's audit facts", async () => {
    const stub = await spawn("audit");
    await stub.send("u", "user", { type: "BUY", service: "CHARGE" });
    await waitFor(
      () => inspect(stub),
      (i) => i.state.log.length === 1,
    );
    const journal = await runInDurableObject(stub, (_i, s) => readJournal(s.storage.sql));
    const done = journal.events.find((e) => e.causeType === "service.onDone");
    expect(done?.payload).toEqual({
      input: { cents: 5 },
      result: { receipt: "r-1" },
      effectId: "2:0",
      audit: { gateway: "test" },
    });
  });

  it("a result its schema refuses fails the try as a Defect", async () => {
    const stub = await spawn("bad");
    await stub.send("u", "user", { type: "BUY", service: "BAD_RESULT" });
    const failed = await waitFor(
      () => inspect(stub),
      (i) => i.state.log.length === 1,
    );
    expect(failed.state.log[0]).toMatch(/^bad Defect Service "BAD_RESULT" returned a result that does not match/);
    expect(failed.outbox).toMatchObject([{ status: "failed", lastErrorTag: "Defect" }]);
  });

  it("ctx.cancel aborts a call in flight; its result is discarded and no callback runs", async () => {
    const stub = await spawn("cancel");
    await stub.send("u", "user", { type: "BUY", service: "SLOW" });
    await waitFor(
      () => inspect(stub),
      (i) => i.outbox[0]?.status === "running",
    );
    await stub.send("u", "user", { type: "CANCEL", id: "2:0" });
    const cancelled = await waitFor(
      () => inspect(stub),
      (i) => i.outbox[0]?.status === "cancelled",
    );
    await new Promise((r) => setTimeout(r, 50));
    const after = await inspect(stub);
    expect(after.outbox).toMatchObject([{ id: "2:0", status: "cancelled" }]);
    expect(after.state.log).toEqual([]);
    expect(cancelled.state.ids).toEqual(["2:0"]);
  });

  it("an at-most-once try cut off by an eviction is an OutcomeUnknown dead letter, never sent again", async () => {
    const stub = await spawn("once");
    await stub.send("u", "user", { type: "BUY", service: "ONCE" });
    await waitFor(
      () => inspect(stub),
      (i) => i.state.log.length === 1,
    );
    await evictWhileRunning(stub);
    const after = await waitFor(
      () => inspect(stub),
      (i) => i.outbox[0]?.status === "failed",
    );
    expect(after.outbox[0]).toMatchObject({ status: "failed", attempts: 1, lastErrorTag: "OutcomeUnknown" });
    expect(after.outbox[0]?.lastError).toMatch(/^outcome unknown: /);
    await new Promise((r) => setTimeout(r, 50));
    expect((await inspect(stub)).state.log).toEqual(["once done"]);
  });

  it("an at-least-once try lost to eviction counts as an attempt: the last one runs onError with Evicted", async () => {
    const stub = await spawn("loose");
    await stub.send("u", "user", { type: "BUY", service: "LOOSE" });
    await waitFor(
      () => inspect(stub),
      (i) => i.state.log.length === 1,
    );
    await evictWhileRunning(stub);
    const after = await waitFor(
      () => inspect(stub),
      (i) => i.state.log.length === 2,
    );
    expect(after.state.log).toEqual(["loose done", "loose error Evicted"]);
    expect(after.outbox[0]).toMatchObject({ status: "failed", lastErrorTag: "Evicted" });
  });

  it("an onDone that throws leaves the row a dead letter naming the callback and the reason", async () => {
    const stub = await spawn("broken");
    await stub.send("u", "user", { type: "BUY", service: "BROKEN_DONE" });
    const after = await waitFor(
      () => inspect(stub),
      (i) => i.outbox[0]?.status === "failed",
    );
    expect(after.outbox[0]?.lastError).toBe("onDone: onDone is broken");
    expect(after.state.log).toEqual([]);
  });
});
