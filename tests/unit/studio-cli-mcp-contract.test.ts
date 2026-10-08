import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { StudioClient, TimelinePage } from "../../packages/studio-cli/src/client";
import { createStudioMcpServer } from "../../packages/studio-cli/src/mcp";

/** A recording fake Studio client: every call is logged with its exact arguments. */
function fakeStudio(overrides: Partial<StudioClient> = {}) {
  const calls: [string, ...unknown[]][] = [];
  const page: TimelinePage = {
    entries: [
      {
        id: 1,
        causeType: "message",
        causeData: JSON.stringify({ messageType: "JOIN", payload: { name: "Juneau" } }),
        stateSnapshot: "{}",
        checksum: "c1",
        createdAt: 5,
      },
    ],
    hasMore: true,
  };
  const studio: StudioClient = {
    list: async (opts) => {
      calls.push(["list", opts]);
      return [{ actorType: "t", actorId: "a" }];
    },
    types: async () => {
      calls.push(["types"]);
      return ["counter", "game"];
    },
    inspect: async (actorType, actorId) => {
      calls.push(["inspect", actorType, actorId]);
      return { state: {} };
    },
    timeline: async (actorType, actorId, opts) => {
      calls.push(["timeline", actorType, actorId, opts]);
      return page;
    },
    view: async (actorType, actorId, opts) => {
      calls.push(["view", actorType, actorId, opts]);
      return { type: "studio.view", role: opts.role, caller: null, callerRole: null, data: 1 };
    },
    ...overrides,
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
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("no content");
  }
  const first: unknown = result.content[0];
  if (typeof first !== "object" || first === null || !("text" in first) || typeof first.text !== "string") {
    throw new Error("no text");
  }
  return first.text;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const ACTOR_TYPE = { type: "string", minLength: 1, maxLength: 128, description: expect.stringMatching(/actor type/i) };
const ACTOR_ID = { type: "string", minLength: 1, maxLength: 512, description: expect.stringMatching(/actor id/i) };
const SAFE_INT = 9007199254740991;

describe("studio MCP server: advertised contract", () => {
  it("names itself", async () => {
    const client = await connect(fakeStudio().studio);
    expect(client.getServerVersion()).toMatchObject({ name: "actor-kit-studio", version: "0.0.1" });
  });

  it("advertises each tool's description, input bounds and read-only annotations", async () => {
    const client = await connect(fakeStudio().studio);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("studio_list_actors")).toMatchObject({
      description: expect.stringMatching(/most recently active/),
      annotations: READ_ONLY,
      inputSchema: {
        properties: {
          type: { type: "string", minLength: 1, maxLength: 128 },
          search: { type: "string", maxLength: 256 },
          limit: { type: "integer", minimum: 1, maximum: 1000 },
          offset: { type: "integer", minimum: 0, maximum: SAFE_INT },
        },
      },
    });
    expect(byName.get("studio_list_actors")?.inputSchema.properties?.["search"]).not.toHaveProperty("minLength");
    expect(byName.get("studio_actor_types")).toMatchObject({
      description: expect.stringMatching(/actor types/),
      annotations: READ_ONLY,
      inputSchema: { properties: {} },
    });
    expect(byName.get("studio_inspect")).toMatchObject({
      description: expect.stringMatching(/redacted/),
      annotations: READ_ONLY,
      inputSchema: { properties: { actorType: ACTOR_TYPE, actorId: ACTOR_ID }, required: ["actorType", "actorId"] },
    });
    expect(byName.get("studio_timeline")).toMatchObject({
      description: expect.stringMatching(/shape:false/),
      annotations: READ_ONLY,
      inputSchema: {
        properties: {
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          limit: { type: "integer", minimum: 1, maximum: 1000 },
          before: { type: "integer", minimum: 1, maximum: SAFE_INT, description: expect.stringMatching(/cursor/) },
          shape: { type: "boolean", description: expect.stringMatching(/true/) },
        },
        required: ["actorType", "actorId"],
      },
    });
    expect(byName.get("studio_view")).toMatchObject({
      description: expect.stringMatching(/role/),
      annotations: READ_ONLY,
      inputSchema: {
        properties: {
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          role: { type: "string", minLength: 1, maxLength: 128 },
          caller: { type: "string", minLength: 1, maxLength: 512 },
        },
        required: ["actorType", "actorId", "role"],
      },
    });
  });
});

describe("studio MCP server: tool calls", () => {
  it("studio_list_actors passes no options when given none", async () => {
    const { studio, calls } = fakeStudio();
    const client = await connect(studio);
    const result = await client.callTool({ name: "studio_list_actors", arguments: {} });
    expect(calls).toStrictEqual([["list", {}]]);
    expect(JSON.parse(text(result))).toEqual([{ actorType: "t", actorId: "a" }]);
  });

  it("studio_list_actors passes every option it is given", async () => {
    const { studio, calls } = fakeStudio();
    const client = await connect(studio);
    await client.callTool({
      name: "studio_list_actors",
      arguments: { type: "game", search: "r", limit: 1000, offset: 0 },
    });
    expect(calls).toStrictEqual([["list", { type: "game", search: "r", limit: 1000, offset: 0 }]]);
  });

  it("studio_actor_types returns the types as pretty JSON", async () => {
    const { studio, calls } = fakeStudio();
    const client = await connect(studio);
    const result = await client.callTool({ name: "studio_actor_types", arguments: {} });
    expect(calls).toStrictEqual([["types"]]);
    expect(text(result)).toBe(JSON.stringify(["counter", "game"], null, 2));
    expect(result.isError).toBeUndefined();
  });

  it("studio_timeline sends no paging options by default and returns shape with hasMore", async () => {
    const { studio, calls } = fakeStudio();
    const client = await connect(studio);
    const result = await client.callTool({ name: "studio_timeline", arguments: { actorType: "c", actorId: "a" } });
    expect(calls).toStrictEqual([["timeline", "c", "a", {}]]);
    expect(JSON.parse(text(result))).toEqual({
      shape: [
        {
          id: 1,
          at: 5,
          causeType: "message",
          messageType: "JOIN",
          payloadKeys: ["name"],
          checksum: "c1",
          changedPaths: [],
        },
      ],
      hasMore: true,
    });
  });

  it("studio_timeline with shape:true still returns the shape", async () => {
    const { studio } = fakeStudio();
    const client = await connect(studio);
    const result = await client.callTool({
      name: "studio_timeline",
      arguments: { actorType: "c", actorId: "a", shape: true },
    });
    expect(text(result)).not.toContain("Juneau");
  });

  it("studio_timeline passes the before cursor", async () => {
    const { studio, calls } = fakeStudio();
    const client = await connect(studio);
    await client.callTool({
      name: "studio_timeline",
      arguments: { actorType: "c", actorId: "a", before: 7, limit: 2 },
    });
    expect(calls).toStrictEqual([["timeline", "c", "a", { limit: 2, before: 7 }]]);
  });

  it("studio_view without a caller passes only the role", async () => {
    const { studio, calls } = fakeStudio();
    const client = await connect(studio);
    await client.callTool({ name: "studio_view", arguments: { actorType: "c", actorId: "a", role: "kid" } });
    expect(calls).toStrictEqual([["view", "c", "a", { role: "kid" }]]);
  });

  it("reports a non-Error failure as text", async () => {
    const { studio } = fakeStudio({
      types: () => Promise.reject("plain failure"),
    });
    const client = await connect(studio);
    const result = await client.callTool({ name: "studio_actor_types", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("plain failure");
  });

  it.each([
    ["studio_list_actors", { type: "x".repeat(129) }],
    ["studio_list_actors", { type: "" }],
    ["studio_list_actors", { search: "x".repeat(257) }],
    ["studio_list_actors", { limit: 0 }],
    ["studio_list_actors", { limit: 1001 }],
    ["studio_list_actors", { offset: -1 }],
    ["studio_inspect", { actorType: "x".repeat(129), actorId: "a" }],
    ["studio_inspect", { actorType: "c", actorId: "x".repeat(513) }],
    ["studio_timeline", { actorType: "c", actorId: "a", before: 0 }],
    ["studio_view", { actorType: "c", actorId: "a", role: "" }],
    ["studio_view", { actorType: "c", actorId: "a", role: "r", caller: "x".repeat(513) }],
  ])("%s rejects out-of-bounds %j without calling Studio", async (name, args) => {
    const { studio, calls } = fakeStudio();
    const client = await connect(studio);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it.each([
    ["studio_list_actors", { type: "x".repeat(128), search: "", limit: 1, offset: 0 }],
    ["studio_inspect", { actorType: "x".repeat(128), actorId: "x".repeat(512) }],
    ["studio_view", { actorType: "c", actorId: "a", role: "x".repeat(128), caller: "x".repeat(512) }],
  ])("%s accepts boundary arguments %j", async (name, args) => {
    const { studio, calls } = fakeStudio();
    const client = await connect(studio);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
