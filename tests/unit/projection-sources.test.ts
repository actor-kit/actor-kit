/**
 * ADR-019 E: where rebuild() reads journals from: the Studio journal route (behind Cloudflare
 * Access, with a service token) or an actor's `__journal` RPC through its Durable Object namespace.
 */
import { describe, expect, it } from "vitest";
import { actorJournalSource, studioJournalSource } from "../../packages/projection/src/index";

const page = { entries: [], hasMore: false };
const query = { order: "asc" as const, from: 3, limit: 50 };

describe("studioJournalSource", () => {
  it("GETs the journal route with the query and headers, returning the parsed JSON", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const source = studioJournalSource({
      baseUrl: "https://game.example.com/ignored-path",
      headers: { "CF-Access-Client-Id": "id" },
      fetch: async (input, init) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) });
        return Response.json(page);
      },
    });
    expect(await source.journal("lot", "room 1", query)).toEqual(page);
    expect(seen[0]?.url).toBe(
      "https://game.example.com/__studio/api/actors/lot/room%201/journal?order=asc&from=3&limit=50",
    );
    expect(seen[0]?.headers.get("CF-Access-Client-Id")).toBe("id");
  });

  it("throws with the status and the Studio error", async () => {
    const source = studioJournalSource({
      baseUrl: "https://game.example.com",
      fetch: async () => Response.json({ error: "Actor not found" }, { status: 404 }),
    });
    await expect(source.journal("lot", "x", query)).rejects.toThrow(
      'journal of lot/x: 404 {"error":"Actor not found"}',
    );
  });

  it("uses the global fetch by default", async () => {
    const urls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json(page);
    };
    try {
      await studioJournalSource({ baseUrl: "https://game.example.com" }).journal("lot", "a", query);
    } finally {
      globalThis.fetch = original;
    }
    expect(urls).toEqual(["https://game.example.com/__studio/api/actors/lot/a/journal?order=asc&from=3&limit=50"]);
  });
});

describe("actorJournalSource", () => {
  function namespace(journal: (opts: unknown) => unknown) {
    const calls: unknown[] = [];
    const ns = {
      idFromName: (name: string) => `id:${name}`,
      get: (id: unknown) => ({
        __journal: async (opts: unknown) => {
          calls.push([id, opts]);
          return journal(opts);
        },
      }),
    };
    return { ns, calls };
  }

  it("calls __journal on the actor's stub, by name", async () => {
    const { ns, calls } = namespace(() => page);
    const source = actorJournalSource((type) => (type === "lot" ? ns : undefined));
    expect(await source.journal("lot", "l1", query)).toEqual(page);
    expect(calls).toEqual([["id:l1", query]]);
  });

  it("throws for an actor type with no namespace, or a stub without __journal", async () => {
    await expect(actorJournalSource(() => undefined).journal("lot", "l1", query)).rejects.toThrow(
      'actorJournalSource: no Durable Object namespace for actor type "lot"',
    );
    const bare = { idFromName: () => "id", get: () => ({}) };
    await expect(actorJournalSource(() => bare).journal("lot", "l1", query)).rejects.toThrow(
      "actorJournalSource: lot/l1 has no __journal RPC (is it an Actor Kit actor with Studio enabled?)",
    );
  });
});
