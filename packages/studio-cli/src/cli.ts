/**
 * `actor-kit studio <command>` — read-only Studio access from a terminal or an agent (ADR-014).
 *
 * Exit codes: 0 ok, 1 Studio/API error, 2 usage error.
 */

import { parseArgs } from "node:util";
import { authFromEnv, createStudioClient, type FetchFn, type StudioClient } from "./client";
import { defined } from "./present";
import { journalShape, timelineShape } from "./shape";

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
  journal <type> <id>          Journal entries (causes, emitted events, trace ids), newest first
                               [--from <seq>] [--to <seq>] [--before <seq>] [--limit <n>]
                               [--cause-type <t>] [--event <name>] [--correlation-id <id>]
                               [--order asc|desc]   --shape: names, keys and checksums only
  view <type> <id> --role <r>  A role's view   [--caller <id>]

Options:
  --url <url>   Worker origin (default: $ACTOR_KIT_STUDIO_URL)
  --help        Show this help

Auth (environment):
  CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET   Access service token (agents)
  CF_ACCESS_TOKEN                                 a person's token: cloudflared access token -app=<url>
  (none)                                          localhost dev mode
`;

/** A command line the CLI cannot run (ADR-018 C: a stable code and a docs URL). */
class UsageError extends Error {
  readonly code = "cli_usage";
  readonly docs = "https://actorkit.dev/errors/cli_usage/";
}

function positiveInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(value) || Number(value) < 1) throw new UsageError(`--${name} must be a positive integer`);
  return Number(value);
}

function actorArgs(command: string, positionals: readonly string[]): [string, string] {
  const [actorType, actorId, ...extra] = positionals;
  if (actorType === undefined || actorId === undefined || extra.length > 0) {
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
  from: { type: "string" },
  to: { type: "string" },
  "cause-type": { type: "string" },
  event: { type: "string" },
  "correlation-id": { type: "string" },
  order: { type: "string" },
  shape: { type: "boolean" },
  help: { type: "boolean" },
} as const;

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };

type Command = (client: StudioClient, positionals: readonly string[], values: Values) => Promise<unknown>;

async function timeline(client: StudioClient, positionals: readonly string[], values: Values): Promise<unknown> {
  const [actorType, actorId] = actorArgs("timeline", positionals);
  const opts = defined({ limit: positiveInt("limit", values.limit), before: positiveInt("before", values.before) });
  const page = await client.timeline(actorType, actorId, opts);
  return values.shape === true ? timelineShape(page.entries) : page;
}

function order(value: string | undefined): "asc" | "desc" | undefined {
  if (value === undefined || value === "asc" || value === "desc") return value;
  throw new UsageError("--order must be asc or desc");
}

async function journal(client: StudioClient, positionals: readonly string[], values: Values): Promise<unknown> {
  const [actorType, actorId] = actorArgs("journal", positionals);
  const opts = defined({
    from: positiveInt("from", values.from),
    to: positiveInt("to", values.to),
    before: positiveInt("before", values.before),
    causeType: values["cause-type"],
    event: values.event,
    correlationId: values["correlation-id"],
    limit: positiveInt("limit", values.limit),
    order: order(values.order),
  });
  const page = await client.journal(actorType, actorId, opts);
  return values.shape === true ? journalShape(page.entries) : page;
}

function view(client: StudioClient, positionals: readonly string[], values: Values): Promise<unknown> {
  const [actorType, actorId] = actorArgs("view", positionals);
  if (values.role === undefined) throw new UsageError("view needs --role <role>");
  return client.view(actorType, actorId, { role: values.role, ...defined({ caller: values.caller }) });
}

const COMMANDS = new Map<string, Command>([
  [
    "list",
    (client, _positionals, values) =>
      client.list(
        defined({
          type: values.type,
          search: values.search,
          limit: positiveInt("limit", values.limit),
          offset: positiveInt("offset", values.offset),
        }),
      ),
  ],
  ["types", (client) => client.types()],
  ["inspect", (client, positionals) => client.inspect(...actorArgs("inspect", positionals))],
  ["timeline", timeline],
  ["journal", journal],
  ["view", view],
]);

function studioUrl(values: Values, env: Record<string, string | undefined>): string {
  const baseUrl = values.url ?? env["ACTOR_KIT_STUDIO_URL"];
  if (baseUrl === undefined || baseUrl === "") {
    throw new UsageError("Set ACTOR_KIT_STUDIO_URL or pass --url <worker origin>");
  }
  return baseUrl;
}

async function run(argv: readonly string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const [group, commandName, ...rest] = positionals;
  if (group === "studio" && values.help === true) {
    io.stdout(USAGE);
    return 0;
  }
  if (group !== "studio" || commandName === undefined) {
    io.stderr(USAGE);
    return 2;
  }
  const client = createStudioClient({
    baseUrl: studioUrl(values, env),
    auth: authFromEnv(env),
    ...defined({ fetch: io.fetch }),
  });
  const command = COMMANDS.get(commandName);
  if (command === undefined) throw new UsageError(`Unknown command "${commandName}"`);
  io.stdout(`${JSON.stringify(await command(client, rest, values), null, 2)}\n`);
  return 0;
}

/** Run the CLI. Returns the exit code. Never prints credentials. */
export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  try {
    return await run(argv, env, io);
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
