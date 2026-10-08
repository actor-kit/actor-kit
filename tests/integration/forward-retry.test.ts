/**
 * Forwards get the executions' treatment (ADR-015 D1): effect id `seq:index`, tries counted,
 * failed tries wait as `retrying` on the shared alarm, the last failure leaves a dead letter, and
 * redrive sends it again under the same id. Studio's outbox lists them.
 */

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

async function courier() {
  const name = unique("courier");
  const stub = env.COURIER.get(env.COURIER.idFromName(name));
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
  return stub;
}

type Stub = Awaited<ReturnType<typeof courier>>;

const Row = z.object({
  id: z.string(),
  service: z.string(),
  status: z.string(),
  attempts: z.number(),
  nextAttemptAt: z.number().nullable(),
  lastError: z.string().nullable(),
  kind: z.literal("forward").optional(),
  target: z.string().optional(),
});
const Inspect = z.object({ outbox: z.array(Row) });

const outbox = async (stub: Stub) => Inspect.parse(await stub.__inspect()).outbox;

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const allAre = (status: string) => (rows: z.infer<typeof Row>[]) =>
  rows.length > 0 && rows.every((r) => r.status === status);

/** Make every waiting retry due and run the alarm, until the outbox settles as `status`. */
async function retryUntil(stub: Stub, status: string) {
  return waitFor(async () => {
    await runInDurableObject(stub, async (_i, s) => {
      s.storage.sql.exec("UPDATE forwards SET next_attempt_at = 0 WHERE status = 'retrying'");
      await s.storage.setAlarm(Date.now() + 60_000);
    });
    await runDurableObjectAlarm(stub);
    return outbox(stub);
  }, allAre(status));
}

const inbox = (name: string) => env.FLAKY_INBOX.get(env.FLAKY_INBOX.idFromName(name));

describe("forward retries", () => {
  it("a failed try waits as retrying, with the alarm at its next attempt, then succeeds on a later try", async () => {
    const stub = await courier();
    const to = unique("inbox");
    await stub.send("alice", "user", { type: "SEND", via: "slow", to, id: "m1", failTimes: 1 });
    const [row] = await waitFor(() => outbox(stub), allAre("retrying"));
    expect(row).toMatchObject({
      kind: "forward",
      service: "slow",
      target: to,
      attempts: 1,
      lastError: "inbox busy (try 1)",
    });
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBe(row?.nextAttemptAt);

    const done = await retryUntil(stub, "done");
    expect(done[0]).toMatchObject({ id: row?.id, attempts: 2, nextAttemptAt: null, lastError: null });
    expect(await inbox(to).received()).toEqual([{ id: "m1", caller: "alice", callerType: "user" }]);
  });

  it("retries on its own (short backoff) and keeps the effect id", async () => {
    const stub = await courier();
    const to = unique("inbox");
    await stub.send("u", "user", { type: "SEND", via: "flaky", to, id: "m2", failTimes: 2 });
    const before = await waitFor(
      () => outbox(stub),
      (rows) => rows.length === 1,
    );
    const done = await retryUntil(stub, "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: before[0]?.id, attempts: 3 });
  });

  it("the last failed try leaves a dead letter; redrive sends it again under the same id", async () => {
    const stub = await courier();
    await stub.send("u", "user", { type: "SEND", via: "dead", to: unique("x"), id: "m3", failTimes: 0 });
    const failed = await retryUntil(stub, "failed");
    expect(failed[0]).toMatchObject({ attempts: 2, nextAttemptAt: null });
    expect(failed[0]?.lastError).toEqual(expect.any(String));

    const effectId = failed[0]?.id ?? "";
    expect(await stub.__redrive({ effectId })).toEqual({ ok: true });
    const again = await waitFor(
      () => outbox(stub),
      (rows) => (rows[0]?.attempts ?? 0) >= 1 && rows[0]?.status !== "pending",
    );
    expect(again[0]?.id).toBe(effectId);
    expect(again[0]?.status).toMatch(/^(retrying|running)$/);
    // Let it run out its tries again, so no retry is still pending when the test ends.
    const redriven = await retryUntil(stub, "failed");
    expect(redriven[0]).toMatchObject({ id: effectId, attempts: 2 });
  });

  it("a forward whose target cannot be resolved is a dead letter at once, with the reason", async () => {
    const stub = await courier();
    await stub.send("u", "user", { type: "SEND", via: "nowhere", to: "t", id: "m4", failTimes: 0 });
    const [row] = await waitFor(() => outbox(stub), allAre("failed"));
    expect(row).toMatchObject({ attempts: 0, lastError: 'Forward target "no-such-actor" t cannot be resolved' });
  });
});
