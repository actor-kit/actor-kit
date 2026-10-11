/**
 * Read-only client for the Actor Kit Studio API (/__studio/api/*), behind Cloudflare Access (ADR-014).
 *
 * Auth: an Access service token (agents) or a person's Access token from
 * `cloudflared access token -app=<url>`. With neither, requests go out unauthenticated
 * (localhost dev mode). Every response is parsed with Zod.
 */

import { z } from "zod";

export type StudioAuth =
  | { kind: "service-token"; clientId: string; clientSecret: string }
  | { kind: "access-token"; token: string }
  | { kind: "none" };

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class StudioClientError extends Error {
  /** ADR-018 C: a stable code and a docs URL. */
  readonly code = "studio_request_failed";
  readonly docs = "https://actorkit.dev/errors/studio_request_failed/";
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "StudioClientError";
    this.status = status;
  }
}

/** An environment setting, with the empty string treated as unset. */
function setting(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return value === "" ? undefined : value;
}

/** Credentials from the environment. Values are never logged or echoed. */
export function authFromEnv(env: Record<string, string | undefined>): StudioAuth {
  const id = setting(env, "CF_ACCESS_CLIENT_ID");
  const secret = setting(env, "CF_ACCESS_CLIENT_SECRET");
  if (id !== undefined && secret !== undefined) return { kind: "service-token", clientId: id, clientSecret: secret };
  if (id !== undefined || secret !== undefined) {
    throw new StudioClientError(
      "Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (an Access service token)",
      null,
    );
  }
  const token = setting(env, "CF_ACCESS_TOKEN");
  return token === undefined ? { kind: "none" } : { kind: "access-token", token };
}

function authHeaders(auth: StudioAuth): Record<string, string> {
  switch (auth.kind) {
    case "service-token":
      return { "CF-Access-Client-Id": auth.clientId, "CF-Access-Client-Secret": auth.clientSecret };
    case "access-token":
      return { "cf-access-token": auth.token };
    case "none":
      return {};
  }
}

// --- Response schemas (the /__studio/api wire shapes) ---

export const TimelineEntrySchema = z.object({
  id: z.number().int(),
  causeType: z.string(),
  causeData: z.string(),
  /** Null when the journal could not rebuild the after-state (ADR-017 §5). */
  stateSnapshot: z.string().nullable(),
  checksum: z.string(),
  createdAt: z.number(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

const TimelineSchema = z.object({ entries: z.array(TimelineEntrySchema), hasMore: z.boolean() });
export type TimelinePage = z.infer<typeof TimelineSchema>;

const ActorEntrySchema = z.looseObject({ actorType: z.string(), actorId: z.string() });
const ActorsSchema = z.object({ actors: z.array(ActorEntrySchema) });
const TypesSchema = z.object({ types: z.array(z.string()) });
const InspectSchema = z.looseObject({ state: z.unknown() });
const ViewSchema = z.union([
  z.object({ type: z.literal("studio.view"), role: z.string(), caller: z.string().nullable(), error: z.string() }),
  z.object({
    type: z.literal("studio.view"),
    role: z.string(),
    caller: z.string().nullable(),
    callerRole: z.string().nullable(),
    data: z.unknown(),
  }),
]);
const ErrorSchema = z.object({ error: z.string() });

export interface StudioClient {
  list(opts?: {
    type?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<z.infer<typeof ActorsSchema>["actors"]>;
  types(): Promise<string[]>;
  inspect(actorType: string, actorId: string): Promise<z.infer<typeof InspectSchema>>;
  timeline(actorType: string, actorId: string, opts?: { limit?: number; before?: number }): Promise<TimelinePage>;
  view(
    actorType: string,
    actorId: string,
    opts: { role: string; caller?: string },
  ): Promise<z.infer<typeof ViewSchema>>;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) search.set(name, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

export function createStudioClient(options: { baseUrl: string; auth: StudioAuth; fetch?: FetchFn }): StudioClient {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new StudioClientError(`Studio URL must be http(s), got ${base.protocol}`, null);
  }
  const doFetch: FetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const headers = authHeaders(options.auth);

  async function get<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
    const url = new URL(`/__studio/api${path}`, base);
    let res: Response;
    try {
      res = await doFetch(url, { headers, redirect: "manual" });
    } catch (err) {
      throw new StudioClientError(
        `Could not reach ${url.origin}: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new StudioClientError(
        `${res.status}: response is not JSON (an Access login page or redirect?). Check the URL and the Access credentials.`,
        res.status,
      );
    }
    if (!res.ok) {
      const body = ErrorSchema.safeParse(json);
      throw new StudioClientError(`${res.status}: ${body.success ? body.data.error : "request failed"}`, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new StudioClientError(
        `Malformed Studio response from ${url.pathname}: ${parsed.error.message}`,
        res.status,
      );
    }
    return parsed.data;
  }

  const actorPath = (actorType: string, actorId: string) =>
    `/actors/${encodeURIComponent(actorType)}/${encodeURIComponent(actorId)}`;

  return {
    list: async (opts = {}) =>
      (
        await get(
          `/actors${query({ type: opts.type, search: opts.search, limit: opts.limit, offset: opts.offset })}`,
          ActorsSchema,
        )
      ).actors,
    types: async () => (await get("/actors/types", TypesSchema)).types,
    inspect: (actorType, actorId) => get(actorPath(actorType, actorId), InspectSchema),
    timeline: (actorType, actorId, opts = {}) =>
      get(
        `${actorPath(actorType, actorId)}/timeline${query({ limit: opts.limit, before: opts.before })}`,
        TimelineSchema,
      ),
    view: (actorType, actorId, opts) =>
      get(`${actorPath(actorType, actorId)}/view${query({ role: opts.role, caller: opts.caller })}`, ViewSchema),
  };
}
