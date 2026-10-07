#!/usr/bin/env node
/**
 * Stdio MCP server. Configure with ACTOR_KIT_STUDIO_URL plus CF_ACCESS_CLIENT_ID/SECRET
 * (agents) or CF_ACCESS_TOKEN (a person). Nothing is written to stdout except protocol frames.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { authFromEnv, createStudioClient } from "./client";
import { createStudioMcpServer } from "./mcp";

const baseUrl = process.env["ACTOR_KIT_STUDIO_URL"];
if (baseUrl === undefined || baseUrl === "") {
  process.stderr.write("actor-kit-studio-mcp: set ACTOR_KIT_STUDIO_URL to the Worker origin\n");
  process.exit(2);
}
const server = createStudioMcpServer(createStudioClient({ baseUrl, auth: authFromEnv(process.env) }));
await server.connect(new StdioServerTransport());
