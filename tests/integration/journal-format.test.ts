/**
 * ADR-018 F in Durable Objects: refused messages are recorded outside the journal (a row, a count per
 * code shown by Studio), callbacks emit domain events onto their journal entry, and a restore pushes
 * the restored view to link subscribers like any transition.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function cashier() {
  const name = unique("cashier");
  const stub = env.CASHIER.get(env.CASHIER.idFromName(name));
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
  return stub;
}

const Rejections = z.object({ rejections: z.object({ total: z.number(), byCode: z.record(z.string(), z.number()) }) });
const RowSchema = z.object({
  code: z.string(),
  message_name: z.string(),
  caller: z.string(),
  role: z.string().nullable(),
});

describe("journal format in a Durable Object (ADR-018 F)", () => {
  it("a refused message is recorded outside the journal and counted for Studio", async () => {
    const stub = await cashier();
    expect(await stub.send("ann", "user", { type: "NOPE" })).toMatchObject({ ok: false, code: "unknown_message" });
    expect(await stub.send("ann", "user", { type: "BUY", service: "NOT_A_SERVICE" })).toMatchObject({
      code: "invalid_payload",
    });
    expect(Rejections.parse(await stub.__inspect()).rejections).toEqual({
      total: 2,
      byCode: { invalid_payload: 1, unknown_message: 1 },
    });
    const { rows, kinds } = await runInDurableObject(stub, (_i, s) => ({
      rows: s.storage.sql.exec("SELECT code, message_name, caller, role FROM rejections ORDER BY id").toArray(),
      kinds: readJournal(s.storage.sql).events.map((e) => e.causeType),
    }));
    expect(rows.map((row) => RowSchema.parse(row))).toEqual([
      { code: "unknown_message", message_name: "NOPE", caller: "ann", role: "any" },
      { code: "invalid_payload", message_name: "BUY", caller: "ann", role: "any" },
    ]);
    expect(kinds).toEqual(["init"]);
  });

  it("onDone emits a domain event onto its journal entry", async () => {
    const stub = await cashier();
    await stub.send("u", "user", { type: "BUY", service: "CHARGE" });
    const done = await waitFor(
      () =>
        runInDurableObject(stub, (_i, s) =>
          readJournal(s.storage.sql).events.find((e) => e.causeType === "service.onDone"),
        ),
      (event) => event !== undefined,
    );
    expect(done?.emitted).toEqual([{ name: "Charged", payload: { effectId: "2:0" } }]);
  });

  it("a restore pushes the restored view to link subscribers", async () => {
    const noticeName = unique("notice-studio");
    const notice = env.NOTICE_STUDIO.get(env.NOTICE_STUDIO.idFromName(noticeName));
    await notice.spawn({ actorId: noticeName, caller: "svc", callerType: "service", input: { text: "first" } });
    const readerName = unique("reader");
    const reader = env.READER.get(env.READER.idFromName(readerName));
    await reader.spawn({ actorId: readerName, caller: "svc", callerType: "service", input: {} });
    await reader.send("u", "user", { type: "FOLLOW", via: "studio", id: noticeName });
    const text = async () =>
      z.object({ state: z.object({ text: z.string() }) }).parse(await reader.__inspect()).state.text;
    await waitFor(text, (t) => t === "first");
    await notice.send("u", "user", { type: "EDIT", text: "second" });
    await waitFor(text, (t) => t === "second");
    expect(await notice.__restore({ toSeq: 1 })).toEqual({ ok: true });
    expect(await waitFor(text, (t) => t === "first")).toBe("first");
  });
});
