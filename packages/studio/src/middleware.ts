/**
 * actorKitStudio() — middleware that intercepts /__studio and /__studio/* routes.
 *
 * Handles:
 * - Auth (no auth on localhost without a secret, secret key otherwise)
 * - Actor listing from StudioRegistry
 * - Actor inspection via __inspect() RPC
 * - Timeline retrieval via __getTimeline() RPC
 * - WebSocket upgrade for live studio connections
 * - Serving the bundled SPA
 *
 * Every path and query parameter is parsed before anything is contacted, and
 * an actor DO is only contacted once the registry confirms it exists, so a
 * lookup never creates (auto-spawns) a phantom actor.
 */

import { z } from "zod";
import { getAsset } from "./ui-assets";

// Identity header constants (duplicated from @actor-kit/worker to avoid cloudflare:workers dependency)
const CALLER_ID_HEADER = "X-Actor-Kit-Caller-Id";
const CALLER_TYPE_HEADER = "X-Actor-Kit-Caller-Type";
const STUDIO_KEY_HEADER = "X-Actor-Kit-Studio-Key";

const STUDIO_PREFIX = "/__studio";
const REGISTRY_BINDING = "STUDIO_REGISTRY";
const ALLOWED_METHODS = "GET, HEAD";

const MAX_LIMIT = 1000;
const MAX_TYPE_LENGTH = 128;
const MAX_ID_LENGTH = 512;
const MAX_SEARCH_LENGTH = 256;

// --- Responses ---

function jsonError(status: number, error: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers });
}

/** Execute an async operation and return JSON. Returns a JSON 500 (message only, no stack) on failure. */
async function asyncJson(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (err) {
    return jsonError(500, err instanceof Error ? err.message : "Unknown error");
  }
}

// --- Bindings and RPC ---

/** Runtime check: does this value look like a DurableObjectNamespace? */
function isNamespace(val: unknown): val is DurableObjectNamespace {
  return (
    typeof val === "object" &&
    val !== null &&
    typeof Reflect.get(val, "idFromName") === "function" &&
    typeof Reflect.get(val, "idFromString") === "function" &&
    typeof Reflect.get(val, "get") === "function"
  );
}

type RpcTarget<K extends string> = Record<K, (...args: unknown[]) => Promise<unknown>>;

/** Runtime check: does the stub expose an RPC method with this name? */
function hasRpc<K extends string>(stub: object, method: K): stub is RpcTarget<K> {
  return typeof Reflect.get(stub, method) === "function";
}

function callRpc<K extends string>(stub: object, method: K, ...args: unknown[]): Promise<unknown> {
  if (!hasRpc(stub, method)) {
    return Promise.reject(new Error(`RPC method "${method}" not found on stub`));
  }
  return stub[method](...args);
}

/** Check if a string looks like a hex DO ID (64 hex chars). */
function isHexId(id: string): boolean {
  return /^[0-9a-f]{64}$/i.test(id);
}

function registryStub(env: Record<string, unknown>): DurableObjectStub | null {
  const binding = env[REGISTRY_BINDING];
  return isNamespace(binding) ? binding.get(binding.idFromName("registry")) : null;
}

// --- Request parsing ---

/** Path below the studio prefix, or null when the request is not a studio request. */
function studioSubpath(pathname: string): string | null {
  if (pathname === STUDIO_PREFIX) return "";
  if (pathname.startsWith(`${STUDIO_PREFIX}/`)) return pathname.slice(STUDIO_PREFIX.length);
  return null;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

const ActorParams = z.object({
  actorType: z.string().min(1).max(MAX_TYPE_LENGTH),
  actorId: z.string().min(1).max(MAX_ID_LENGTH),
});
type ActorParams = z.infer<typeof ActorParams>;

/** Decimal digits only: rejects "", "-1", "1.5", "1e3", "0x10", " 5", "NaN", "Infinity". */
const nonNegativeInt = z
  .string()
  .regex(/^\d{1,15}$/, "must be a non-negative integer")
  .transform(Number);

const ListQuery = z.object({
  type: z.string().min(1).max(MAX_TYPE_LENGTH).optional(),
  search: z.string().max(MAX_SEARCH_LENGTH).optional(),
  limit: nonNegativeInt.pipe(z.number().min(1).max(MAX_LIMIT)).optional(),
  offset: nonNegativeInt.optional(),
});

const TimelineQuery = z.object({
  limit: nonNegativeInt.pipe(z.number().min(1).max(MAX_LIMIT)).optional(),
  before: nonNegativeInt.optional(),
});

/** Read the named query params (first occurrence), dropping absent ones. */
function queryParams(url: URL, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ");
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

function parseQuery<S extends z.ZodType<Record<string, unknown>>>(
  schema: S,
  url: URL,
  names: readonly string[],
): Parsed<z.output<S>> {
  const result = schema.safeParse(queryParams(url, names));
  if (!result.success) {
    return { ok: false, response: jsonError(400, `Invalid query parameter ${describeIssues(result.error)}`) };
  }
  return { ok: true, value: result.data };
}

function parseActorParams(rawType: string, rawId: string): Parsed<ActorParams> {
  const actorType = decodeSegment(rawType);
  const actorId = decodeSegment(rawId);
  if (actorType === null || actorId === null) {
    return { ok: false, response: jsonError(400, "Malformed percent-encoding in actor type or id") };
  }
  const result = ActorParams.safeParse({ actorType, actorId });
  if (!result.success) {
    return { ok: false, response: jsonError(400, `Invalid actor path: ${describeIssues(result.error)}`) };
  }
  return { ok: true, value: result.data };
}

// --- Middleware ---

/**
 * Studio middleware. Returns a Response if the request matches /__studio or /__studio/*,
 * or null if the request should be handled by the user's normal routing.
 */
export function actorKitStudio(
  request: Request,
  env: Record<string, unknown>,
  _ctx: ExecutionContext,
): Response | Promise<Response> | null {
  const url = new URL(request.url);
  const path = studioSubpath(url.pathname);
  if (path === null) return null;

  // Auth before anything else, so unauthenticated callers cannot probe routes.
  const authResult = checkAuth(request, url, env);
  if (authResult !== null) return authResult;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError(405, `Method ${request.method} not allowed`, { Allow: ALLOWED_METHODS });
  }

  if (path === "/api" || path.startsWith("/api/")) {
    return routeApi(path, url, env);
  }

  // Match /actors/:type/:id/ws — WebSocket upgrade
  const wsMatch = path.match(/^\/actors\/([^/]+)\/([^/]+)\/ws$/);
  if (wsMatch?.[1] !== undefined && wsMatch[2] !== undefined) {
    return handleStudioWebSocket(request, wsMatch[1], wsMatch[2], env);
  }

  return serveUi(path);
}

function routeApi(path: string, url: URL, env: Record<string, unknown>): Response | Promise<Response> {
  if (path === "/api/actors" || path === "/api/actors/") {
    return handleListActors(url, env);
  }

  if (path === "/api/actors/types") {
    return handleActorTypes(env);
  }

  // Match /api/actors/:type/:id/timeline
  const timelineMatch = path.match(/^\/api\/actors\/([^/]+)\/([^/]+)\/timeline$/);
  if (timelineMatch?.[1] !== undefined && timelineMatch[2] !== undefined) {
    return handleTimeline(timelineMatch[1], timelineMatch[2], url, env);
  }

  // Match /api/actors/:type/:id
  const actorMatch = path.match(/^\/api\/actors\/([^/]+)\/([^/]+)$/);
  if (actorMatch?.[1] !== undefined && actorMatch[2] !== undefined) {
    return handleInspect(actorMatch[1], actorMatch[2], env);
  }

  return jsonError(404, `Unknown studio API route: ${path}`);
}

/** Serve an embedded asset; any non-asset path falls back to the SPA shell (client-side routes). */
function serveUi(path: string): Response {
  const isAssetPath = path.startsWith("/assets/");
  const asset =
    getAsset(path === "" || path === "/" ? "/index.html" : path) ?? (isAssetPath ? null : getAsset("/index.html"));
  if (asset === null) {
    return jsonError(404, "Not found");
  }
  return new Response(asset.body, {
    headers: {
      "Content-Type": asset.contentType,
      "Cache-Control": asset.contentType === "text/html" ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}

// --- Auth ---

/**
 * Dev mode = no secret configured AND the request URL's hostname is exactly localhost/127.0.0.1.
 * The hostname comes from the URL Cloudflare routed on; forwarding headers, Origin, Referer and
 * query params are never consulted.
 */
function checkAuth(request: Request, url: URL, env: Record<string, unknown>): Response | null {
  const secret = env["ACTOR_KIT_STUDIO_SECRET"];

  if (secret === undefined || secret === "") {
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return null;
    }
    return jsonError(
      403,
      "Studio is not configured. Set ACTOR_KIT_STUDIO_SECRET via `wrangler secret put ACTOR_KIT_STUDIO_SECRET`.",
    );
  }

  const key = request.headers.get(STUDIO_KEY_HEADER);
  if (key !== secret) {
    return jsonError(401, "Unauthorized");
  }

  return null;
}

// --- Actor resolution ---

type ResolvedActor = { stub: DurableObjectStub; doId: DurableObjectId };

/**
 * Resolve the actor's DO stub without contacting it (getting a stub does not instantiate the DO).
 * Failures (no such binding, id not valid for the namespace) are returned as a Response.
 */
function resolveActor(env: Record<string, unknown>, params: ActorParams): ResolvedActor | Response {
  const bindingName = params.actorType.toUpperCase().replace(/-/g, "_");
  const binding = env[bindingName];
  if (bindingName === REGISTRY_BINDING || !isNamespace(binding)) {
    return jsonError(404, `Actor type "${params.actorType}" not found in env bindings`);
  }

  let doId: DurableObjectId;
  try {
    // If the actorId is a hex DO ID, use idFromString to avoid double-hashing
    doId = isHexId(params.actorId) ? binding.idFromString(params.actorId) : binding.idFromName(params.actorId);
  } catch {
    return jsonError(404, `Actor "${params.actorType}/${params.actorId}" not found`);
  }

  return { stub: binding.get(doId), doId };
}

/**
 * The registry lists an actor under its spawn name or, when auto-spawned, under its DO hex id,
 * so both are checked. Without a registry binding there is nothing to check against.
 */
async function actorExists(env: Record<string, unknown>, params: ActorParams, doId: DurableObjectId): Promise<boolean> {
  const registry = registryStub(env);
  if (registry === null) return true;

  const candidates = [params.actorId];
  const hex = doId.toString();
  if (hex !== params.actorId) candidates.push(hex);

  for (const candidate of candidates) {
    if ((await callRpc(registry, "hasActor", params.actorType, candidate)) === true) return true;
  }
  return false;
}

function actorNotFound(params: ActorParams): Response {
  return jsonError(404, `Actor "${params.actorType}/${params.actorId}" not found`);
}

// --- Route handlers ---

function handleListActors(url: URL, env: Record<string, unknown>): Response | Promise<Response> {
  const query = parseQuery(ListQuery, url, ["type", "search", "limit", "offset"]);
  if (!query.ok) return query.response;

  const registry = registryStub(env);
  if (registry === null) {
    return Response.json({ actors: [], error: "StudioRegistry not found in env bindings" }, { status: 503 });
  }

  return asyncJson(async () => ({ actors: await callRpc(registry, "listActors", query.value) }));
}

function handleActorTypes(env: Record<string, unknown>): Response | Promise<Response> {
  const registry = registryStub(env);
  if (registry === null) {
    return Response.json({ types: [], error: "StudioRegistry not found in env bindings" }, { status: 503 });
  }

  return asyncJson(async () => ({ types: await callRpc(registry, "getActorTypes") }));
}

function handleInspect(rawType: string, rawId: string, env: Record<string, unknown>): Response | Promise<Response> {
  const params = parseActorParams(rawType, rawId);
  if (!params.ok) return params.response;

  const actor = resolveActor(env, params.value);
  if (actor instanceof Response) return actor;

  return withExistingActor(env, actor, params.value, () => asyncJson(() => callRpc(actor.stub, "__inspect")));
}

function handleTimeline(
  rawType: string,
  rawId: string,
  url: URL,
  env: Record<string, unknown>,
): Response | Promise<Response> {
  const params = parseActorParams(rawType, rawId);
  if (!params.ok) return params.response;

  const query = parseQuery(TimelineQuery, url, ["limit", "before"]);
  if (!query.ok) return query.response;

  const actor = resolveActor(env, params.value);
  if (actor instanceof Response) return actor;

  return withExistingActor(env, actor, params.value, () =>
    asyncJson(() => callRpc(actor.stub, "__getTimeline", query.value)),
  );
}

function handleStudioWebSocket(
  request: Request,
  rawType: string,
  rawId: string,
  env: Record<string, unknown>,
): Response | Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return jsonError(426, "Expected WebSocket", { Upgrade: "websocket" });
  }

  const params = parseActorParams(rawType, rawId);
  if (!params.ok) return params.response;

  const actor = resolveActor(env, params.value);
  if (actor instanceof Response) return actor;

  return withExistingActor(env, actor, params.value, () => {
    // Stamp __studio identity headers (scrubbing any inbound ones) and forward to DO
    const stampedRequest = new Request(request);
    stampedRequest.headers.delete(CALLER_ID_HEADER);
    stampedRequest.headers.delete(CALLER_TYPE_HEADER);
    stampedRequest.headers.set(CALLER_ID_HEADER, "__studio");
    stampedRequest.headers.set(CALLER_TYPE_HEADER, "service");
    return actor.stub.fetch(stampedRequest);
  });
}

/** Run `use` only once the registry confirms the actor exists; never contacts the actor DO otherwise. */
async function withExistingActor(
  env: Record<string, unknown>,
  actor: ResolvedActor,
  params: ActorParams,
  use: () => Promise<Response>,
): Promise<Response> {
  let exists: boolean;
  try {
    exists = await actorExists(env, params, actor.doId);
  } catch (err) {
    return jsonError(500, err instanceof Error ? err.message : "Unknown error");
  }
  if (!exists) return actorNotFound(params);
  return use();
}
