/**
 * ADR-019 F + ADR-014: journal entries leave the actor redacted like timeline entries: cause values
 * (payload, input, result, viewData) and emitted event payloads by the actor's studio.redact
 * patterns, callers hashed for agents. Ids, names and trace ids are kept.
 */
import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../../packages/worker/src/runtime/journal-query";
import {
  createCallerHasher,
  projectJournalEntry,
  type StudioProjection,
} from "../../packages/worker/src/runtime/studio-project";
import { compileRedaction, REDACTED } from "../../packages/worker/src/runtime/studio-redact";

const redactor = compileRedaction(["name", "**.secret"]);
const human: StudioProjection = { redactor, hashCaller: null };
const agent: StudioProjection = { redactor, hashCaller: createCallerHasher("test-only-hash-key") };
const plain: StudioProjection = { redactor: compileRedaction(undefined), hashCaller: null };

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "lot/l1/3",
    seq: 3,
    causeType: "message",
    cause: { messageType: "BID", caller: "ann", callerType: "user", role: "bidder", payload: { name: "Ann", n: 1 } },
    emitted: [
      { name: "Outbid", payload: { name: "Bo", deep: { secret: "s" } }, published: true },
      { name: "Noted", payload: 4, published: false },
    ],
    correlationId: "lot/l1/2",
    causationId: "lot/l1/2:0",
    createdAt: 9,
    codeVersion: 1,
    checksum: "c",
    ...overrides,
  };
}

describe("projectJournalEntry", () => {
  it("redacts the cause payload and each emitted payload for people, keeping callers", async () => {
    const out = await projectJournalEntry(entry(), human);
    expect(out.cause).toEqual({
      messageType: "BID",
      caller: "ann",
      callerType: "user",
      role: "bidder",
      payload: { name: REDACTED, n: 1 },
    });
    expect(out.emitted).toEqual([
      { name: "Outbid", payload: { name: REDACTED, deep: { secret: REDACTED } }, published: true },
      { name: "Noted", payload: 4, published: false },
    ]);
    expect(out).toMatchObject({ id: "lot/l1/3", seq: 3, correlationId: "lot/l1/2", causationId: "lot/l1/2:0" });
  });

  it("hashes the caller for agents", async () => {
    const out = await projectJournalEntry(entry(), agent);
    expect(out.cause["caller"]).toMatch(/^caller:[0-9a-f]{12}$/);
    expect(out.cause["caller"]).toBe(await createCallerHasher("test-only-hash-key")("ann"));
  });

  it("redacts service input and result each from its own root", async () => {
    const cause = { service: "charge", input: { name: "Ann" }, result: { name: "Ann", ok: true } };
    const out = await projectJournalEntry(entry({ causeType: "service.onDone", cause, emitted: [] }), human);
    expect(out.cause).toEqual({ service: "charge", input: { name: REDACTED }, result: { name: REDACTED, ok: true } });
  });

  it("returns the entry unchanged without patterns for people", async () => {
    const original = entry();
    expect(await projectJournalEntry(original, plain)).toEqual(original);
  });
});
