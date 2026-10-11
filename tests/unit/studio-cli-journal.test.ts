/**
 * ADR-019 F in the Studio CLI and MCP server: `actor-kit studio journal <type> <id>` and the
 * `studio_journal` tool query the journal route; `--shape` (the MCP default) keeps names, keys,
 * published flags and checksums, never values, callers or trace ids.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { runCli } from "../../packages/studio-cli/src/cli";
import {
  createStudioClient,
  type JournalEntry,
  type JournalPage,
  type StudioClient,
} from "../../packages/studio-cli/src/client";
import { createStudioMcpServer } from "../../packages/studio-cli/src/mcp";
import { journalShape } from "../../packages/studio-cli/src/shape";

const entry: JournalEntry = {
  id: "lot/l1/4",
  seq: 4,
  causeType: "message",
  cause: { messageType: "BID", caller: "caller:abc", callerType: "user", role: "bidder", payload: { amount: 12 } },
  emitted: [
    { name: "Sold", payload: { to: "Juneau" }, published: true },
    { name: "Closed", payload: 3, published: false },
  ],
  correlationId: "lot/l1/3",
  causationId: "lot/l1/3:0",
  createdAt: 1004,
  codeVersion: 1,
  checksum: "c4",
};
const serviceEntry: JournalEntry = {
  ...entry,
  id: "lot/l1/5",
  seq: 5,
  causeType: "service.onDone",
  cause: { service: "charge", input: { card: "4242" }, result: { ok: true } },
  emitted: [],
};
const page: JournalPage = { entries: [serviceEntry, entry], hasMore: true };

function harness(respond: (url: URL) => Response = () => Response.json(page)) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: URL[] = [];
  const io = {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      return respond(url);
    },
  };
  return { out, err, urls, io };
}

const ENV = { ACTOR_KIT_STUDIO_URL: "https://game.example.com" };

describe("journalShape", () => {
  it("keeps names, keys, published flags and checksums, oldest first", () => {
    expect(journalShape(page.entries)).toEqual([
      {
        seq: 4,
        at: 1004,
        causeType: "message",
        checksum: "c4",
        emitted: [
          { name: "Sold", published: true, payloadKeys: ["to"] },
          { name: "Closed", published: false },
        ],
        messageType: "BID",
        role: "bidder",
        callerType: "user",
        payloadKeys: ["amount"],
      },
      {
        seq: 5,
        at: 1004,
        causeType: "service.onDone",
        checksum: "c4",
        emitted: [],
        service: "charge",
        inputKeys: ["card"],
      },
    ]);
  });

  it("never carries a value, a caller or a trace id", () => {
    const text = JSON.stringify(journalShape(page.entries));
    for (const secret of ["Juneau", "4242", "caller:abc", "lot/l1/3", "12"]) expect(text).not.toContain(secret);
  });
});

describe("createStudioClient().journal", () => {
  it("sends only the options that are set and parses the page", async () => {
    const h = harness();
    const client = createStudioClient({
      baseUrl: "https://game.example.com",
      auth: { kind: "none" },
      fetch: h.io.fetch,
    });
    const result = await client.journal("lot", "l 1", { event: "Sold", order: "asc", limit: 2 });
    expect(h.urls[0]?.pathname).toBe("/__studio/api/actors/lot/l%201/journal");
    expect(h.urls[0]?.search).toBe("?event=Sold&limit=2&order=asc");
    expect(result).toEqual(page);
  });

  it("sends every option", async () => {
    const h = harness();
    const client = createStudioClient({
      baseUrl: "https://game.example.com",
      auth: { kind: "none" },
      fetch: h.io.fetch,
    });
    await client.journal("lot", "l1", {
      from: 1,
      to: 9,
      before: 8,
      causeType: "timer",
      event: "Sold",
      correlationId: "lot/l1/3",
      limit: 5,
      order: "desc",
    });
    expect(Object.fromEntries(h.urls[0]?.searchParams ?? [])).toEqual({
      from: "1",
      to: "9",
      before: "8",
      causeType: "timer",
      event: "Sold",
      correlationId: "lot/l1/3",
      limit: "5",
      order: "desc",
    });
  });

  it("rejects a malformed page", async () => {
    const h = harness(() => Response.json({ entries: [{ seq: "x" }], hasMore: false }));
    const client = createStudioClient({
      baseUrl: "https://game.example.com",
      auth: { kind: "none" },
      fetch: h.io.fetch,
    });
    await expect(client.journal("lot", "l1")).rejects.toThrow("Malformed Studio response");
  });
});

describe("actor-kit studio journal", () => {
  it("passes every flag as a query parameter and prints the page", async () => {
    const h = harness();
    const argv = [
      "studio",
      "journal",
      "lot",
      "l1",
      "--from",
      "2",
      "--to",
      "9",
      "--before",
      "8",
      "--cause-type",
      "timer",
      "--event",
      "Sold",
      "--correlation-id",
      "lot/l1/3",
      "--limit",
      "5",
      "--order",
      "asc",
    ];
    expect(await runCli(argv, ENV, h.io)).toBe(0);
    expect(h.urls[0]?.pathname).toBe("/__studio/api/actors/lot/l1/journal");
    expect(Object.fromEntries(h.urls[0]?.searchParams ?? [])).toEqual({
      from: "2",
      to: "9",
      before: "8",
      causeType: "timer",
      event: "Sold",
      correlationId: "lot/l1/3",
      limit: "5",
      order: "asc",
    });
    expect(JSON.parse(h.out.join(""))).toEqual(page);
  });

  it("--shape prints only the shape", async () => {
    const h = harness();
    expect(await runCli(["studio", "journal", "lot", "l1", "--shape"], ENV, h.io)).toBe(0);
    expect(h.urls[0]?.search).toBe("");
    expect(JSON.parse(h.out.join(""))).toEqual(journalShape(page.entries));
  });

  it("is in the usage", async () => {
    const h = harness();
    await runCli(["studio", "--help"], ENV, h.io);
    expect(h.out.join("")).toMatch(/journal <type> <id>.*--cause-type.*--correlation-id/s);
  });

  it("accepts --order desc", async () => {
    const h = harness();
    expect(await runCli(["studio", "journal", "lot", "l1", "--order", "desc"], ENV, h.io)).toBe(0);
    expect(h.urls[0]?.search).toBe("?order=desc");
  });

  it.each([
    [["studio", "journal", "lot"], /^Usage: actor-kit studio journal <type> <id>\n/],
    [["studio", "journal", "lot", "l1", "--order", "up"], /^--order must be asc or desc\n/],
    [["studio", "journal", "lot", "l1", "--from", "x"], /^--from must be a positive integer\n/],
    [["studio", "journal", "lot", "l1", "--to", "0"], /^--to must be a positive integer\n/],
    [["studio", "journal", "lot", "l1", "--before", "x"], /^--before must be a positive integer\n/],
    [["studio", "journal", "lot", "l1", "--limit", "1.5"], /^--limit must be a positive integer\n/],
  ])("usage error %j exits 2", async (argv, message) => {
    const h = harness();
    expect(await runCli(argv, ENV, h.io)).toBe(2);
    expect(h.err.join("")).toMatch(message);
  });
});

describe("studio_journal MCP tool", () => {
  function fakeStudio() {
    const calls: unknown[][] = [];
    const unused = async (): Promise<never> => {
      throw new Error("unused");
    };
    const studio: StudioClient = {
      list: unused,
      types: unused,
      inspect: unused,
      timeline: unused,
      view: unused,
      journal: async (actorType, actorId, opts) => {
        calls.push([actorType, actorId, opts]);
        return page;
      },
    };
    return { studio, calls };
  }

  async function connect(studio: StudioClient) {
    const server = createStudioMcpServer(studio);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  function text(result: unknown): string {
    const content: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "content") : null;
    const first: unknown = Array.isArray(content) ? content[0] : null;
    const value: unknown = typeof first === "object" && first !== null ? Reflect.get(first, "text") : null;
    if (typeof value !== "string") throw new Error("no text");
    return value;
  }

  it("advertises its filters, bounds and read-only annotations", async () => {
    const client = await connect(fakeStudio().studio);
    const tool = (await client.listTools()).tools.find((t) => t.name === "studio_journal");
    expect(tool).toMatchObject({
      description: expect.stringMatching(/shape:false/),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        properties: {
          from: { type: "integer", minimum: 1, description: expect.stringMatching(/lowest seq/) },
          to: { type: "integer", minimum: 1, description: expect.stringMatching(/highest seq/) },
          before: { type: "integer", minimum: 1, description: expect.stringMatching(/cursor/) },
          causeType: { type: "string", minLength: 1, maxLength: 64, description: expect.stringMatching(/timer/) },
          event: { type: "string", minLength: 1, maxLength: 256, description: expect.stringMatching(/domain event/) },
          correlationId: {
            type: "string",
            minLength: 1,
            maxLength: 1024,
            description: expect.stringMatching(/flow/),
          },
          limit: { type: "integer", minimum: 1, maximum: 1000 },
          order: { type: "string", enum: ["asc", "desc"], description: expect.stringMatching(/newest first/) },
          shape: { type: "boolean", description: expect.stringMatching(/true/) },
        },
        required: ["actorType", "actorId"],
      },
    });
  });

  it("returns the shape by default, sending only the filters given", async () => {
    const { studio, calls } = fakeStudio();
    const client = await connect(studio);
    const result = await client.callTool({
      name: "studio_journal",
      arguments: { actorType: "lot", actorId: "l1", event: "Sold" },
    });
    expect(calls).toStrictEqual([["lot", "l1", { event: "Sold" }]]);
    expect(JSON.parse(text(result))).toEqual({ shape: journalShape(page.entries), hasMore: true });
  });

  it("returns the full redacted page with shape:false, passing every filter", async () => {
    const { studio, calls } = fakeStudio();
    const client = await connect(studio);
    const args = {
      from: 1,
      to: 9,
      before: 8,
      causeType: "timer",
      event: "Sold",
      correlationId: "lot/l1/3",
      limit: 5,
      order: "asc",
    };
    const result = await client.callTool({
      name: "studio_journal",
      arguments: { actorType: "lot", actorId: "l1", ...args, shape: false },
    });
    expect(calls).toStrictEqual([["lot", "l1", args]]);
    expect(JSON.parse(text(result))).toEqual(page);
  });
});
