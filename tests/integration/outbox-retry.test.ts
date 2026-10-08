/**
 * Effect ids and outbox retries (ADR-015 D1): rows are keyed `seq:index`, tries are counted,
 * failed tries wait as `retrying` (on the DO alarm) and onError runs only after the last try.
 * `failed` rows are dead letters until __redrive moves them back to `pending`, same effect id.
 */

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

async function spawn(prefix: string) {
  const name = unique(prefix);
  const stub = env.RETRIER.get(env.RETRIER.idFromName(name));
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
  return stub;
}

type Stub = Awaited<ReturnType<typeof spawn>>;

const Row = z.object({
  id: z.string(),
  service: z.string(),
  status: z.string(),
  attempts: z.number(),
  nextAttemptAt: z.number().nullable(),
  lastError: z.string().nullable(),
});
const Inspect = z.object({
  state: z.object({ done: z.array(z.unknown()), errors: z.array(z.string()) }),
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

const settled = (status: string) => (i: z.infer<typeof Inspect>) => i.outbox.every((r) => r.status === status);

/** Seq of the latest `message` event: the transition that declared the effects. */
async function lastSeq(stub: Stub): Promise<number> {
  return runInDurableObject(
    stub,
    (_i, state) =>
      readJournal(state.storage.sql)
        .events.filter((e) => e.causeType === "message")
        .at(-1)?.seq ?? 0,
  );
}

describe("effect ids (ADR-015 D1)", () => {
  it("an execution's row id is the declaring transition's seq and its index", async () => {
    const stub = await spawn("ids");
    await stub.send("u", "user", { type: "TWICE" });
    const seq = await lastSeq(stub);
    const { outbox } = await waitFor(() => inspect(stub), settled("done"));
    expect(outbox.map((r) => r.id)).toEqual([`${seq}:1`, `${seq}:0`]);
  });

  it("the service gets the effect id and the try number as its third argument", async () => {
    const stub = await spawn("third-arg");
    await stub.send("u", "user", { type: "RUN", service: "FLAKY", tag: "t", succeedOn: 1 });
    const seq = await lastSeq(stub);
    const { state } = await waitFor(
      () => inspect(stub),
      (i) => i.state.done.length === 1,
    );
    expect(state.done[0]).toMatchObject({ effectId: `${seq}:0`, attempt: 1 });
  });

  it("orders the Studio outbox by (seq, index) as integers, newest first", async () => {
    const stub = await spawn("order");
    for (let i = 0; i < 11; i++)
      await stub.send("u", "user", { type: "RUN", service: "FLAKY", tag: `${i}`, succeedOn: 1 });
    const { outbox } = await waitFor(() => inspect(stub), settled("done"));
    const seqs = outbox.map((r) => Number(r.id.split(":")[0]));
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    expect(seqs).toHaveLength(11);
  });

  it("with journal: false, ids still come from the per-transition counter", async () => {
    const name = unique("journal-off-ids");
    const stub = env.RETRIER_NO_JOURNAL.get(env.RETRIER_NO_JOURNAL.idFromName(name));
    await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
    // PATIENT waits 60s before its retry, so no onDone/onError transition takes a seq meanwhile.
    await stub.send("u", "user", { type: "RUN", service: "PATIENT", tag: "1", succeedOn: 1 });
    await stub.send("u", "user", { type: "RUN", service: "PATIENT", tag: "2", succeedOn: 1 });
    const ids = await runInDurableObject(stub, (_i, state) => ({
      events: state.storage.sql.exec("SELECT COUNT(*) AS n FROM events").one()["n"],
      ids: state.storage.sql
        .exec("SELECT id FROM executions ORDER BY seq, idx")
        .toArray()
        .map((r) => String(r["id"])),
    }));
    // spawn is transition 1; no journal rows are written.
    expect(ids).toEqual({ events: 0, ids: ["2:0", "3:0"] });
  });
});

describe("outbox retries (ADR-015 D1)", () => {
  it("counts every try in attempts and succeeds on a later try without calling onError", async () => {
    const stub = await spawn("flaky");
    await stub.send("u", "user", { type: "RUN", service: "FLAKY", tag: "f", succeedOn: 3 });
    const result = await waitFor(() => inspect(stub), settled("done"));
    expect(result.outbox[0]).toMatchObject({ status: "done", attempts: 3, nextAttemptAt: null });
    expect(result.state.errors).toEqual([]);
    expect(result.state.done[0]).toMatchObject({ attempt: 3 });
  });

  it("retries reuse the same effect id", async () => {
    const stub = await spawn("same-id");
    await stub.send("u", "user", { type: "RUN", service: "FLAKY", tag: "f", succeedOn: 2 });
    const seq = await lastSeq(stub);
    const { state, outbox } = await waitFor(() => inspect(stub), settled("done"));
    expect(outbox.map((r) => r.id)).toEqual([`${seq}:0`]);
    expect(state.done[0]).toMatchObject({ effectId: `${seq}:0`, attempt: 2 });
  });

  it("fails after the last try, then runs onError exactly once", async () => {
    const stub = await spawn("doomed");
    await stub.send("u", "user", { type: "RUN", service: "DOOMED", tag: "d", succeedOn: 1 });
    const result = await waitFor(() => inspect(stub), settled("failed"));
    expect(result.outbox[0]).toMatchObject({ status: "failed", attempts: 2, lastError: "no luck: d" });
    expect(result.state.errors).toEqual(["no luck: d"]);
  });

  it("a failed try waits as retrying, with the DO alarm set to its next attempt", async () => {
    const stub = await spawn("patient");
    const before = Date.now();
    await stub.send("u", "user", { type: "RUN", service: "PATIENT", tag: "p", succeedOn: 1 });
    const { outbox, state } = await waitFor(() => inspect(stub), settled("retrying"));
    const row = outbox[0];
    expect(row).toMatchObject({ status: "retrying", attempts: 1, lastError: "no luck: p" });
    expect(row?.nextAttemptAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(state.errors).toEqual([]);
    const alarm = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
    expect(alarm).toBe(row?.nextAttemptAt);
  });

  it("alarm() runs retries that are due and leaves the rest waiting", async () => {
    const stub = await spawn("alarm-due");
    await stub.send("u", "user", { type: "RUN", service: "PATIENT", tag: "p", succeedOn: 1 });
    await waitFor(() => inspect(stub), settled("retrying"));
    // Not due yet: the alarm runs early (as after a deploy) and must not retry anything.
    await runDurableObjectAlarm(stub);
    expect((await inspect(stub)).outbox[0]).toMatchObject({ status: "retrying", attempts: 1 });
    // Make it due, then fire the alarm: the second (last) try fails and onError runs.
    await runInDurableObject(stub, async (_i, s) => {
      s.storage.sql.exec("UPDATE executions SET next_attempt_at = 0");
      await s.storage.setAlarm(Date.now() + 60_000);
    });
    await runDurableObjectAlarm(stub);
    const result = await waitFor(() => inspect(stub), settled("failed"));
    expect(result.outbox[0]).toMatchObject({ status: "failed", attempts: 2 });
    expect(result.state.errors).toEqual(["no luck: p"]);
  });

  it("a service without a retry option gets the default policy: 3 tries, 1s apart first", async () => {
    const stub = await spawn("defaulted");
    const before = Date.now();
    await stub.send("u", "user", { type: "RUN", service: "DEFAULTED", tag: "x", succeedOn: 1 });
    const { outbox } = await waitFor(() => inspect(stub), settled("retrying"));
    expect(outbox[0]?.attempts).toBe(1);
    expect(outbox[0]?.nextAttemptAt).toBeGreaterThanOrEqual(before + 800);
    expect(outbox[0]?.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 1200);
  });

  it("a row left running by a crash runs again on wake", async () => {
    const stub = await spawn("crash");
    await stub.send("u", "user", { type: "RUN", service: "FLAKY", tag: "c", succeedOn: 1 });
    await waitFor(() => inspect(stub), settled("done"));
    await runInDurableObject(stub, (instance, s) => {
      s.storage.sql.exec("UPDATE executions SET status = 'running'");
      instance.persistedLoaded = false;
    });
    await stub.getSnapshot("u", "user");
    const result = await waitFor(
      () => inspect(stub),
      (i) => i.state.done.length === 2,
    );
    expect(result.outbox[0]).toMatchObject({ status: "done", attempts: 2 });
  });
});

describe("redrive (ADR-015 D1)", () => {
  it("moves a failed row back to pending under the same effect id and runs it again", async () => {
    const stub = await spawn("redrive");
    await stub.send("u", "user", { type: "RUN", service: "DOOMED", tag: "r", succeedOn: 1 });
    const failed = await waitFor(() => inspect(stub), settled("failed"));
    const id = failed.outbox[0]?.id ?? "";
    expect(await stub.__redrive({ effectId: id })).toEqual({ ok: true });
    const again = await waitFor(
      () => inspect(stub),
      (i) => i.state.errors.length === 2,
    );
    expect(again.outbox).toHaveLength(1);
    expect(again.outbox[0]).toMatchObject({ id, status: "failed", attempts: 2 });
  });

  it("refuses rows that are not dead letters", async () => {
    const stub = await spawn("redrive-refuse");
    await stub.send("u", "user", { type: "RUN", service: "FLAKY", tag: "ok", succeedOn: 1 });
    const done = await waitFor(() => inspect(stub), settled("done"));
    expect(await stub.__redrive({ effectId: done.outbox[0]?.id ?? "" })).toEqual({
      ok: false,
      error: expect.stringContaining("not a failed"),
    });
    expect(await stub.__redrive({ effectId: "999:0" })).toMatchObject({ ok: false });
  });

  it("is refused when Studio is disabled", async () => {
    const name = unique("redrive-off");
    const stub = env.STUDIO_OFF.get(env.STUDIO_OFF.idFromName(name));
    await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
    let message = "";
    try {
      await stub.__redrive({ effectId: "1:0" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/Studio is not enabled/);
  });
});
