import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createStudioClient } from "../../packages/studio-cli/src/client";
import { createStudioMcpServer } from "../../packages/studio-cli/src/mcp";

const entry = {
  id: 1,
  causeType: "message",
  causeData: JSON.stringify({ messageType: "JOIN", payload: { name: "Juneau" } }),
  stateSnapshot: "{}",
  checksum: "c1",
  createdAt: 5,
};

async function connect(respond: (url: URL) => Response) {
  const urls: URL[] = [];
  const studio = createStudioClient({
    baseUrl: "https://game.example.com",
    auth: { kind: "none" },
    fetch: async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      return respond(url);
    },
  });
  const server = createStudioMcpServer(studio);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, urls };
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

describe("actor-kit-studio-mcp", () => {
  it("exposes exactly the read-only tools", async () => {
    const { client } = await connect(() => Response.json({}));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "studio_actor_types",
      "studio_inspect",
      "studio_journal",
      "studio_list_actors",
      "studio_timeline",
      "studio_view",
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it("studio_inspect calls the inspect route", async () => {
    const { client, urls } = await connect(() => Response.json({ initialized: true, state: { n: 2 } }));
    const result = await client.callTool({ name: "studio_inspect", arguments: { actorType: "counter", actorId: "a" } });
    expect(urls[0]?.pathname).toBe("/__studio/api/actors/counter/a");
    expect(JSON.parse(text(result))).toMatchObject({ state: { n: 2 } });
  });

  it("studio_timeline defaults to shape (no values)", async () => {
    const { client, urls } = await connect(() => Response.json({ entries: [entry], hasMore: false }));
    const result = await client.callTool({
      name: "studio_timeline",
      arguments: { actorType: "c", actorId: "a", limit: 10 },
    });
    expect(urls[0]?.search).toBe("?limit=10");
    expect(text(result)).not.toContain("Juneau");
    expect(JSON.parse(text(result))).toMatchObject({ shape: [{ causeType: "message", payloadKeys: ["name"] }] });
  });

  it("studio_timeline with shape:false returns the (server-redacted) entries", async () => {
    const { client } = await connect(() => Response.json({ entries: [entry], hasMore: true }));
    const result = await client.callTool({
      name: "studio_timeline",
      arguments: { actorType: "c", actorId: "a", shape: false },
    });
    expect(JSON.parse(text(result))).toEqual({ entries: [entry], hasMore: true });
  });

  it("studio_view passes role and caller", async () => {
    const { client, urls } = await connect(() =>
      Response.json({ type: "studio.view", role: "kid", caller: "u", callerRole: "kid", data: {} }),
    );
    await client.callTool({
      name: "studio_view",
      arguments: { actorType: "c", actorId: "a", role: "kid", caller: "u" },
    });
    expect(urls[0]?.search).toBe("?role=kid&caller=u");
  });

  it("reports API errors as tool errors", async () => {
    const { client } = await connect(() => Response.json({ error: "Actor not found" }, { status: 404 }));
    const result = await client.callTool({ name: "studio_inspect", arguments: { actorType: "c", actorId: "x" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("404: Actor not found");
  });

  it("rejects invalid arguments", async () => {
    const { client, urls } = await connect(() => Response.json({}));
    const result = await client.callTool({
      name: "studio_timeline",
      arguments: { actorType: "c", actorId: "a", limit: -1 },
    });
    expect(result.isError).toBe(true);
    expect(urls).toEqual([]);
  });
});
