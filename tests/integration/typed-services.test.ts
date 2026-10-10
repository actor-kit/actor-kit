/**
 * Typed services in the Durable Object (ADR-016). §1: a service's third argument carries its actor and
 * an idempotency key unique across the deployment; a forward carries the same fields to its target,
 * whose handler reads them as ctx.delivery (journaled, so the actor's journal replays). §2: services fail
 * with typed, tagged errors; declared ones are not retried by default, the built-ins are, and onError,
 * the journal and the outbox see the parsed error.
 */

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { replayJournal } from "@actor-kit/test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { abortedTries, TellerContract } from "./src/typed-services-actors";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

async function teller() {
  const name = unique("teller");
  const stub = env.TELLER.get(env.TELLER.idFromName(name));
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
  return { name, stub };
}

async function till() {
  const name = unique("till");
  const stub = env.TILL.get(env.TILL.idFromName(name));
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
  return { name, stub };
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

const TellerInspect = z.object({ state: z.object({ echoes: z.array(z.unknown()), errors: z.array(z.unknown()) }) });
const TillInspect = z.object({
  state: z.object({ received: z.array(z.object({ text: z.string(), delivery: z.unknown() })) }),
});

/** Seq of the latest `message` event: the transition that declared the effects. */
async function lastMessageSeq(stub: DurableObjectStub): Promise<number> {
  return runInDurableObject(
    stub,
    (_i, state) =>
      readJournal(state.storage.sql)
        .events.filter((e) => e.causeType === "message")
        .at(-1)?.seq ?? 0,
  );
}

describe("idempotency (ADR-016 §1)", () => {
  it("a service gets its actor, effect id, idempotency key, try number and an unaborted signal", async () => {
    const { name, stub } = await teller();
    await stub.send("u", "user", { type: "RUN", service: "ECHO" });
    const seq = await lastMessageSeq(stub);
    const { state } = await waitFor(
      async () => TellerInspect.parse(await stub.__inspect()),
      (i) => i.state.echoes.length === 1,
    );
    expect(state.echoes).toEqual([
      {
        actorType: "teller",
        actorId: name,
        effectId: `${seq}:0`,
        idempotencyKey: `teller/${name}/${seq}:0`,
        attempt: 1,
        signalAborted: false,
      },
    ]);
  });

  it("two actors at the same journal position get different idempotency keys", async () => {
    const a = await teller();
    const b = await teller();
    await a.stub.send("u", "user", { type: "RUN", service: "ECHO" });
    await b.stub.send("u", "user", { type: "RUN", service: "ECHO" });
    const keys = await Promise.all(
      [a, b].map(async ({ stub }) => {
        const { state } = await waitFor(
          async () => TellerInspect.parse(await stub.__inspect()),
          (i) => i.state.echoes.length === 1,
        );
        return z.object({ effectId: z.string(), idempotencyKey: z.string() }).parse(state.echoes[0]);
      }),
    );
    expect(keys[0]?.effectId).toBe(keys[1]?.effectId);
    expect(keys[0]?.idempotencyKey).not.toBe(keys[1]?.idempotencyKey);
  });

  it("a forward carries its effect to the target as ctx.delivery, and the target's journal replays it", async () => {
    const sender = await teller();
    const target = await till();
    await sender.stub.send("u", "user", { type: "FORWARD", to: target.name, text: "hi" });
    const seq = await lastMessageSeq(sender.stub);
    const { state } = await waitFor(
      async () => TillInspect.parse(await target.stub.__inspect()),
      (i) => i.state.received.length === 1,
    );
    expect(state.received).toEqual([
      {
        text: "hi",
        delivery: {
          actorType: "teller",
          actorId: sender.name,
          effectId: `${seq}:0`,
          idempotencyKey: `teller/${sender.name}/${seq}:0`,
          attempt: 1,
        },
      },
    ]);
    const facts = await runInDurableObject(target.stub, (_i, s) => readJournal(s.storage.sql).events.at(-1)?.facts);
    expect(facts).toEqual({ delivery: expect.objectContaining({ idempotencyKey: `teller/${sender.name}/${seq}:0` }) });
  });

  it("a message sent directly has no delivery; malformed delivery metadata is refused at the boundary", async () => {
    const target = await till();
    expect(await target.stub.send("u", "user", { type: "DELIVER", text: "direct" })).toEqual({ ok: true });
    const refused = await target.stub.send(
      "u",
      "user",
      { type: "DELIVER", text: "bad" },
      {
        actorType: "teller",
        actorId: "x",
        effectId: "1:0",
        idempotencyKey: "",
        attempt: 1,
      },
    );
    expect(refused).toMatchObject({ ok: false, error: "invalid_delivery" });
    const { state } = TillInspect.parse(await target.stub.__inspect());
    expect(state.received).toEqual([{ text: "direct", delivery: null }]);
  });
});

const Row = z.object({
  id: z.string(),
  service: z.string(),
  status: z.string(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  lastErrorTag: z.string().optional(),
});
const Outbox = z.object({ outbox: z.array(Row) });

/** Make every waiting retry due and run the alarm, until `ok`. */
async function retryUntil(stub: DurableObjectStub, ok: (i: z.infer<typeof TellerInspect>) => boolean) {
  return waitFor(async () => {
    await runInDurableObject(stub, async (_i, s) => {
      s.storage.sql.exec("UPDATE executions SET next_attempt_at = 0 WHERE status = 'retrying'");
      await s.storage.setAlarm(Date.now() + 60_000);
    });
    await runDurableObjectAlarm(stub);
    return TellerInspect.parse(await stub.__inspect());
  }, ok);
}

async function outboxRow(stub: DurableObjectStub) {
  const [row] = Outbox.parse(await stub.__inspect()).outbox;
  return row;
}

describe("typed service errors (ADR-016 §2)", () => {
  it("a declared error is not retried: onError gets it parsed, the outbox shows its tag", async () => {
    const { stub } = await teller();
    await stub.send("u", "user", { type: "RUN", service: "DECLINE" });
    const { state } = await waitFor(
      async () => TellerInspect.parse(await stub.__inspect()),
      (i) => i.state.errors.length === 1,
    );
    expect(state.errors).toEqual([{ _tag: "CardDeclined", reason: "stolen card" }]);
    expect(await outboxRow(stub)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastErrorTag: "CardDeclined",
      lastError: '{"_tag":"CardDeclined","reason":"stolen card"}',
    });
  });

  it("the journal stores the parsed error, and the journal replays", async () => {
    const { stub } = await teller();
    await stub.send("u", "user", { type: "RUN", service: "DECLINE" });
    await waitFor(
      async () => TellerInspect.parse(await stub.__inspect()),
      (i) => i.state.errors.length === 1,
    );
    const journal = await runInDurableObject(stub, (_i, s) => readJournal(s.storage.sql));
    expect(journal.events.at(-1)).toMatchObject({
      causeType: "service.onError",
      name: "DECLINE",
      payload: { error: { _tag: "CardDeclined", reason: "stolen card" } },
    });
    expect((await replayJournal(TellerContract, journal)).state).toEqual(
      TellerInspect.parse(await stub.__inspect()).state,
    );
  });

  it("anything else thrown is a Defect, retried until the last try", async () => {
    const { stub } = await teller();
    await stub.send("u", "user", { type: "RUN", service: "BROKEN" });
    const { state } = await retryUntil(stub, (i) => i.state.errors.length === 1);
    expect(state.errors).toEqual([{ _tag: "Defect", message: "socket hang up" }]);
    expect(await outboxRow(stub)).toMatchObject({
      status: "failed",
      attempts: 2,
      lastErrorTag: "Defect",
      lastError: "socket hang up",
    });
  });

  it("a fail() value the service's errors do not declare is a Defect", async () => {
    const { stub } = await teller();
    await stub.send("u", "user", { type: "RUN", service: "MISFIT" });
    const { state } = await waitFor(
      async () => TellerInspect.parse(await stub.__inspect()),
      (i) => i.state.errors.length === 1,
    );
    expect(state.errors).toEqual([
      {
        _tag: "Defect",
        message: expect.stringContaining(`fail({ _tag: "Stolen" }) does not match the service's errors`),
      },
    ]);
  });

  it("retry.while retries a declared error it names", async () => {
    const { stub } = await teller();
    await stub.send("u", "user", { type: "RUN", service: "LIMITED" });
    const { state } = await retryUntil(stub, (i) => i.state.echoes.length === 1);
    expect(state).toEqual({ echoes: [{ attempt: 2 }], errors: [] });
    expect(await outboxRow(stub)).toMatchObject({ status: "done", attempts: 2 });
    expect(await outboxRow(stub)).not.toHaveProperty("lastErrorTag");
  });

  it("restore redelivers a recorded typed error as it was", async () => {
    const { stub } = await teller();
    await stub.send("u", "user", { type: "RUN", service: "DECLINE" });
    const declared = await lastMessageSeq(stub);
    await waitFor(
      async () => TellerInspect.parse(await stub.__inspect()),
      (i) => i.state.errors.length === 1,
    );
    expect(await stub.__restore({ toSeq: declared })).toEqual({ ok: true });
    const { state } = TellerInspect.parse(await stub.__inspect());
    expect(state.errors).toEqual([{ _tag: "CardDeclined", reason: "stolen card" }]);
    const journal = await runInDurableObject(stub, (_i, s) => readJournal(s.storage.sql));
    expect(journal.events.slice(-2).map((e) => e.causeType)).toEqual(["restore", "service.onError"]);
  });
});

describe("timeouts and cancellation (ADR-016 §3)", () => {
  it("a try that runs out of time is aborted and fails as a Timeout; its late result is discarded", async () => {
    const { name, stub } = await teller();
    await stub.send("u", "user", { type: "RUN", service: "SLOW" });
    const seq = await lastMessageSeq(stub);
    const { state } = await waitFor(
      async () => TellerInspect.parse(await stub.__inspect()),
      (i) => i.state.errors.length === 1,
    );
    expect(state).toEqual({ echoes: [], errors: [{ _tag: "Timeout", ms: 50 }] });
    expect(await outboxRow(stub)).toMatchObject({ status: "failed", attempts: 1, lastErrorTag: "Timeout" });
    const key = `teller/${name}/${seq}:0`;
    await waitFor(
      async () => abortedTries.get(key),
      (reason) => reason !== undefined,
    );
    expect(abortedTries.get(key)).toBe('{"_tag":"Timeout","ms":50}');
    await new Promise((r) => setTimeout(r, 50));
    expect(TellerInspect.parse(await stub.__inspect()).state.echoes).toEqual([]);
  });

  it("restore aborts a try of an undone effect; its late result is discarded", async () => {
    const { name, stub } = await teller();
    await stub.send("u", "user", { type: "RUN", service: "HANG" });
    const seq = await lastMessageSeq(stub);
    await waitFor(
      () => outboxRow(stub),
      (row) => row?.status === "running",
    );
    expect(await stub.__restore({ toSeq: seq - 1 })).toEqual({ ok: true });
    const key = `teller/${name}/${seq}:0`;
    await waitFor(
      async () => abortedTries.get(key),
      (reason) => reason !== undefined,
    );
    expect(abortedTries.get(key)).toContain(`restored to seq ${seq - 1}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(TellerInspect.parse(await stub.__inspect()).state).toEqual({ echoes: [], errors: [] });
    expect(await outboxRow(stub)).toMatchObject({
      status: "failed",
      lastError: `cancelled: the actor was restored to seq ${seq - 1}`,
    });
  });
});
