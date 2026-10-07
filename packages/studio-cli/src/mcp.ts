/**
 * actor-kit-studio-mcp — the CLI's read-only tools as an MCP server (ADR-014).
 *
 * Every tool is read-only. `studio_timeline` returns the shape (no values) by default:
 * an agent asks for the full, server-redacted entries only when it needs them.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { StudioClient } from "./client";
import { timelineShape } from "./shape";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const actorType = z.string().min(1).max(128).describe("Actor type, e.g. \"game\"");
const actorId = z.string().min(1).max(512).describe("Actor id (name or 64-hex DO id)");

async function respond(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await run(), null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
}

export function createStudioMcpServer(client: StudioClient): McpServer {
  const server = new McpServer({ name: "actor-kit-studio", version: "0.0.1" });

  server.registerTool(
    "studio_list_actors",
    {
      description: "List actors known to the Studio registry, most recently active first.",
      inputSchema: {
        type: z.string().min(1).max(128).optional(),
        search: z.string().max(256).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      respond(() =>
        client.list({
          ...(args.type === undefined ? {} : { type: args.type }),
          ...(args.search === undefined ? {} : { search: args.search }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.offset === undefined ? {} : { offset: args.offset }),
        }),
      ),
  );

  server.registerTool(
    "studio_actor_types",
    { description: "List the actor types Studio has seen.", annotations: READ_ONLY },
    () => respond(() => client.types()),
  );

  server.registerTool(
    "studio_inspect",
    {
      description:
        "Current state, connections, outbox and links of one actor. Values the actor declared in studio.redact come back as \"[redacted]\"; callers are hashed for agents.",
      inputSchema: { actorType, actorId },
      annotations: READ_ONLY,
    },
    (args) => respond(() => client.inspect(args.actorType, args.actorId)),
  );

  server.registerTool(
    "studio_timeline",
    {
      description:
        "Timeline of state changes, newest first. By default returns only the shape (cause types, message/service names, payload keys, changed state paths, checksums), which is safe to paste into an issue. Pass shape:false for the full server-redacted entries.",
      inputSchema: {
        actorType,
        actorId,
        limit: z.number().int().min(1).max(1000).optional(),
        before: z.number().int().min(1).optional().describe("Exclusive entry-id cursor for older pages"),
        shape: z.boolean().optional().describe("Default true"),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      respond(async () => {
        const page = await client.timeline(args.actorType, args.actorId, {
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.before === undefined ? {} : { before: args.before }),
        });
        return args.shape === false ? page : { shape: timelineShape(page.entries), hasMore: page.hasMore };
      }),
  );

  server.registerTool(
    "studio_view",
    {
      description: "What one role (and caller, for perCaller views) would receive, redacted like inspect.",
      inputSchema: { actorType, actorId, role: z.string().min(1).max(128), caller: z.string().min(1).max(512).optional() },
      annotations: READ_ONLY,
    },
    (args) =>
      respond(() =>
        client.view(args.actorType, args.actorId, {
          role: args.role,
          ...(args.caller === undefined ? {} : { caller: args.caller }),
        }),
      ),
  );

  return server;
}
