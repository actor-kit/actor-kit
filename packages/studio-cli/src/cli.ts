/**
 * `actor-kit studio <command>` — read-only Studio access from a terminal or an agent (ADR-014).
 *
 * Exit codes: 0 ok, 1 Studio/API error, 2 usage error.
 */

import { parseArgs } from "node:util";
import { authFromEnv, createStudioClient, type FetchFn, type StudioClient } from "./client";
import { timelineShape } from "./shape";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  fetch?: FetchFn;
}

export const USAGE = `Usage: actor-kit studio <command> [options]

Read-only access to Actor Kit Studio (/__studio/api) behind Cloudflare Access.

Commands:
  list                         List actors   [--type <t>] [--search <s>] [--limit <n>] [--offset <n>]
  types                        List actor types
  inspect <type> <id>          Current state, connections, outbox and links (redacted by the actor)
  timeline <type> <id>         Timeline entries, newest first   [--limit <n>] [--before <id>]
                               --shape: cause types, payload keys, changed paths and checksums only
  view <type> <id> --role <r>  A role's view   [--caller <id>]

Options:
  --url <url>   Worker origin (default: $ACTOR_KIT_STUDIO_URL)
  --help        Show this help

Auth (environment):
  CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET   Access service token (agents)
  CF_ACCESS_TOKEN                                 a person's token: cloudflared access token -app=<url>
  (none)                                          localhost dev mode
`;

class UsageError extends Error {}

function positiveInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(value) || Number(value) < 1) throw new UsageError(`--${name} must be a positive integer`);
  return Number(value);
}

function actorArgs(command: string, positionals: readonly string[]): [string, string] {
  const [actorType, actorId] = positionals;
  if (actorType === undefined || actorId === undefined || positionals.length !== 2) {
    throw new UsageError(`Usage: actor-kit studio ${command} <type> <id>`);
  }
  return [actorType, actorId];
}

const OPTIONS = {
  url: { type: "string" },
  type: { type: "string" },
  search: { type: "string" },
  limit: { type: "string" },
  offset: { type: "string" },
  before: { type: "string" },
  role: { type: "string" },
  caller: { type: "string" },
  shape: { type: "boolean" },
  help: { type: "boolean" },
} as const;

async function execute(
  client: StudioClient,
  command: string,
  positionals: readonly string[],
  values: { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string },
): Promise<unknown> {
  switch (command) {
    case "list": {
      const opts: { type?: string; search?: string; limit?: number; offset?: number } = {};
      if (values.type !== undefined) opts.type = values.type;
      if (values.search !== undefined) opts.search = values.search;
      const limit = positiveInt("limit", values.limit);
      if (limit !== undefined) opts.limit = limit;
      const offset = positiveInt("offset", values.offset);
      if (offset !== undefined) opts.offset = offset;
      return await client.list(opts);
    }
    case "types":
      return await client.types();
    case "inspect":
      return await client.inspect(...actorArgs(command, positionals));
    case "timeline": {
      const [actorType, actorId] = actorArgs(command, positionals);
      const opts: { limit?: number; before?: number } = {};
      const limit = positiveInt("limit", values.limit);
      if (limit !== undefined) opts.limit = limit;
      const before = positiveInt("before", values.before);
      if (before !== undefined) opts.before = before;
      const page = await client.timeline(actorType, actorId, opts);
      return values.shape === true ? timelineShape(page.entries) : page;
    }
    case "view": {
      const [actorType, actorId] = actorArgs(command, positionals);
      if (values.role === undefined) throw new UsageError("view needs --role <role>");
      return await client.view(actorType, actorId, {
        role: values.role,
        ...(values.caller === undefined ? {} : { caller: values.caller }),
      });
    }
    default:
      throw new UsageError(`Unknown command "${command}"`);
  }
}

/** Run the CLI. Returns the exit code. Never prints credentials. */
export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    const [group, command, ...rest] = positionals;
    if (values.help === true && group === "studio") {
      io.stdout(USAGE);
      return 0;
    }
    if (group !== "studio" || command === undefined) {
      io.stderr(USAGE);
      return 2;
    }
    const baseUrl = values.url ?? env["ACTOR_KIT_STUDIO_URL"];
    if (baseUrl === undefined || baseUrl === "") {
      throw new UsageError("Set ACTOR_KIT_STUDIO_URL or pass --url <worker origin>");
    }
    const client = createStudioClient({
      baseUrl,
      auth: authFromEnv(env),
      ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
    });
    const result = await execute(client, command, rest, values);
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    // node:util parseArgs reports unknown/malformed options as a TypeError with an ERR_PARSE_ARGS_* code.
    if (err instanceof UsageError || (err instanceof TypeError && "code" in err)) {
      io.stderr(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
