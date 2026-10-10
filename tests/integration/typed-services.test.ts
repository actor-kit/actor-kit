/**
 * Typed services in the Durable Object (ADR-016). §1: a service's third argument carries its actor and
 * an idempotency key unique across the deployment; a forward carries the same fields to its target,
 * whose handler reads them as ctx.delivery (journaled, so the actor's journal replays).
 */

import { env, runInDurableObject } from "cloudflare:test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

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
