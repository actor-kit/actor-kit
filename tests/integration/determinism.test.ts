/** ADR-018 E in a Durable Object: each `determinism` mode with a handler that reads Date.now(). */

import { env, runInDurableObject } from "cloudflare:test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

async function spawn(binding: DurableObjectNamespace, prefix: string) {
  const name = unique(prefix);
  const stub = binding.get(binding.idFromName(name));
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
  return stub;
}

async function lastEntry(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_i, s) => readJournal(s.storage.sql).events.at(-1));
}

describe("determinism modes in a Durable Object (ADR-018 E)", () => {
  it("warn (default): the message is accepted and its journal entry is flagged", async () => {
    const stub = await spawn(env.STAMP_WARN, "warn");
    expect(await stub.send("u", "user", { type: "STAMP" })).toEqual({ ok: true });
    expect(await lastEntry(stub)).toMatchObject({ name: "STAMP", nondeterministic: true });
    expect(await stub.send("u", "user", { type: "SAFE" })).toEqual({ ok: true });
    const safe = await lastEntry(stub);
    expect(safe?.name).toBe("SAFE");
    expect(safe !== undefined && "nondeterministic" in safe).toBe(false);
  });

  it("throw: the transition fails and nothing is written", async () => {
    const stub = await spawn(env.STAMP_THROW, "throw");
    const error = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.send("u", "user", { type: "STAMP" });
        return null;
      } catch (e) {
        return e instanceof Error ? { message: e.message, code: Reflect.get(e, "code") } : String(e);
      }
    });
    expect(error).toMatchObject({ code: "nondeterminism", message: expect.stringContaining("Date.now()") });
    expect((await lastEntry(stub))?.causeType).toBe("init");
  });

  it("off: accepted and not flagged", async () => {
    const stub = await spawn(env.STAMP_OFF, "off");
    expect(await stub.send("u", "user", { type: "STAMP" })).toEqual({ ok: true });
    const entry = await lastEntry(stub);
    expect(entry?.name).toBe("STAMP");
    expect(entry !== undefined && "nondeterministic" in entry).toBe(false);
  });
});
