/**
 * ADR-018 C applied to the ADR-019 C/E/F code: every error thrown by view schemas, the codec, the
 * journal query and @actor-kit/projection is an ActorKitError with a stable code and a docs URL.
 */
import { ActorKitError, decode, encode, enumOf, schema, string, uint8, union } from "@actor-kit/core";
import { describe, expect, it } from "vitest";
import { valueMetaOf } from "../../packages/core/src/schema";
import { projection } from "../../packages/projection/src/index";
import { actorJournalSource, studioJournalSource } from "../../packages/projection/src/sources";
import { parseJournalOptions } from "../../packages/worker/src/runtime/journal-query";

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new ActorKitError("invalid_schema", "expected a throw");
}

async function rejected(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new ActorKitError("invalid_schema", "expected a rejection");
}

function coded(error: unknown, code: string) {
  expect(error).toBeInstanceOf(ActorKitError);
  expect(error).toMatchObject({ code, docs: `https://actorkit.dev/errors/${code}/` });
}

const Shape = union("kind", { a: schema({ n: uint8 }) });

describe("ADR-019 error codes", () => {
  it.each([
    () => enumOf(JSON.parse("[]")),
    () => enumOf(["a", "a"]),
    () => enumOf(Array.from({ length: 65537 }, (_, i) => i)),
    () => union("kind", {}),
    () => union("kind", { a: schema({ kind: uint8 }) }),
    () => union("kind", Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`v${i}`, schema({})]))),
  ])("building an invalid schema is invalid_schema (%#)", (build) => {
    coded(caught(build), "invalid_schema");
  });

  it("a nullable field not built by schema() is invalid_schema", () => {
    coded(
      caught(() => valueMetaOf({ name: "r", type: "nullable", innerType: "uint8" })),
      "invalid_schema",
    );
  });

  it("encoding a value outside an enum or an unknown variant is invalid_view_value, and so is parse()", () => {
    coded(
      caught(() => encode(schema({ e: enumOf(["a"]) }), JSON.parse('{"e":"b"}'))),
      "invalid_view_value",
    );
    coded(
      caught(() => encode(schema({ s: Shape }), JSON.parse('{"s":{"kind":"z"}}'))),
      "invalid_view_value",
    );
    coded(
      caught(() => schema({ s: string }).parse({ s: 1 })),
      "invalid_view_value",
    );
  });

  it("decoding bytes the schema cannot have written is invalid_frame", () => {
    coded(
      caught(() => decode(schema({ e: enumOf(["a", "b"]) }), new Uint8Array([5]))),
      "invalid_frame",
    );
    coded(
      caught(() => decode(schema({ s: Shape }), new Uint8Array([3]))),
      "invalid_frame",
    );
    coded(
      caught(() => decode(schema({ s: string }), new Uint8Array(9).fill(0xff))),
      "invalid_frame",
    );
  });

  it("an invalid journal query is invalid_journal_query", () => {
    coded(
      caught(() => parseJournalOptions({ limit: 0 })),
      "invalid_journal_query",
    );
  });

  it("projection: a bad table or a batch from another queue is invalid_projection", async () => {
    coded(
      caught(() => projection({ queue: "q", table: "1x", db: () => ({}), apply: () => [] })),
      "invalid_projection",
    );
    const p = projection({ queue: "q", db: () => ({}), apply: () => [] });
    coded(await rejected(() => p.queue({ queue: "other", messages: [] }, {})), "invalid_projection");
  });

  it("projection sources: a Studio error, a missing namespace or a non-actor stub", async () => {
    const studio = studioJournalSource({
      baseUrl: "https://x.example",
      fetch: async () => Response.json({ error: "nope" }, { status: 403 }),
    });
    const query = { order: "asc" as const, from: 1, limit: 1 };
    coded(await rejected(() => studio.journal("lot", "a", query)), "studio_request_failed");
    coded(await rejected(() => actorJournalSource(() => undefined).journal("lot", "a", query)), "actor_not_found");
    const bare = { idFromName: () => "id", get: () => ({}) };
    coded(await rejected(() => actorJournalSource(() => bare).journal("lot", "a", query)), "actor_not_found");
  });

  it("rebuild: a journal that is empty, pruned or malformed is incomplete_journal", async () => {
    const p = projection({ queue: "q", db: () => ({ prepare: () => stmt, batch: async () => [] }), apply: () => [] });
    const stmt = { bind: () => stmt, run: async () => ({}), all: async () => ({ results: [] }) };
    const actors = [{ actorType: "lot", actorId: "a" }];
    const page = (entries: unknown[]) => ({ journal: async () => ({ entries, hasMore: false }) });
    coded(await rejected(() => p.rebuild({}, { source: page([]), actors })), "incomplete_journal");
    const pruned = [{ id: "lot/a/3", seq: 3, causeType: "message", emitted: [], correlationId: null, createdAt: 1 }];
    coded(await rejected(() => p.rebuild({}, { source: page(pruned), actors })), "incomplete_journal");
    coded(await rejected(() => p.rebuild({}, { source: page([{ seq: "x" }]), actors })), "incomplete_journal");
  });
});
