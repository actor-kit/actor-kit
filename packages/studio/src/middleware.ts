/**
 * actorKitStudio() — middleware that intercepts /__studio and /__studio/* routes.
 *
 * Handles:
 * - Auth: Cloudflare Access JWT, or localhost dev mode when Access is not configured (ADR-014)
 * - One audit wide-event per studio request
 * - Actor listing from StudioRegistry
 * - Actor inspection via __inspect() RPC
 * - Timeline retrieval via __getTimeline() RPC
 * - Actions (mutate scope only): POST .../actions — redrive a dead letter, fire a timer now, restore (ADR-015)
 * - WebSocket upgrade for live studio connections
 * - Serving the bundled SPA
 *
 * Every path and query parameter is parsed before anything is contacted, and
 * an actor DO is only contacted once the registry confirms it exists, so a
 * lookup never creates (auto-spawns) a phantom actor.
 */

import { ActorKitError } from "@actor-kit/core";
import { z } from "zod";
import { type AccessDeps, authenticateStudio, hasScope, remoteAccessKeys, type StudioPrincipal } from "./access";
import { getAsset } from "./ui-assets";

// Identity header constants (duplicated from @actor-kit/worker to avoid cloudflare:workers dependency)
const CALLER_ID_HEADER = "X-Actor-Kit-Caller-Id";
const CALLER_TYPE_HEADER = "X-Actor-Kit-Caller-Type";
/** Who is looking: the DO hashes callers for agents (ADR-014). Stamped by this middleware only. */
const STUDIO_VIEWER_HEADER = "X-Actor-Kit-Studio-Viewer";

const STUDIO_PREFIX = "/__studio";
const REGISTRY_BINDING = "STUDIO_REGISTRY";
const ALLOWED_METHODS = "GET, HEAD";

const MAX_LIMIT = 1000;
const MAX_TYPE_LENGTH = 128;
const MAX_ID_LENGTH = 512;
const MAX_SEARCH_LENGTH = 256;
const MAX_ROLE_LENGTH = 128;

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
    return Promise.reject(new ActorKitError("studio_unavailable", `RPC method "${method}" not found on stub`));
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
  const isStudio = pathname === STUDIO_PREFIX || pathname.startsWith(`${STUDIO_PREFIX}/`);
  return isStudio ? pathname.slice(STUDIO_PREFIX.length) : null;
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

const ViewQuery = z.object({
  role: z.string().min(1).max(MAX_ROLE_LENGTH),
  caller: z.string().min(1).max(MAX_ID_LENGTH).optional(),
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

/** Every schema here is a flat object, so each issue names its field. */
function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
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

// --- Audit ---

export type StudioRoute = "ui" | "list" | "types" | "inspect" | "timeline" | "view" | "action" | "ws" | "unknown";

/** One line per studio request (ADR-014). Never carries bodies, query values or the JWT. */
export interface StudioAuditEvent {
  event: "studio.request";
  principal: StudioPrincipal["kind"] | "anonymous";
  subject?: string;
  method: string;
  route: StudioRoute;
  actorType?: string;
  actorId?: string;
  status: number;
  durationMs: number;
  /** ok < 400, denied = 401/403, rejected = other 4xx (bad input, not found), error = 5xx. */
  outcome: "ok" | "denied" | "rejected" | "error";
}

function outcomeOf(status: number): StudioAuditEvent["outcome"] {
  if (status < 400) return "ok";
  if (status === 401 || status === 403) return "denied";
  return status < 500 ? "rejected" : "error";
}

interface RouteInfo {
  route: StudioRoute;
  actorType?: string;
  actorId?: string;
}

type ActorRoute = "inspect" | "timeline" | "view" | "action" | "ws";

/** A request below the studio prefix, matched once and shared by routing and the audit event. */
type RouteMatch = { route: Exclude<StudioRoute, ActorRoute> } | { route: ActorRoute; rawType: string; rawId: string };

/** Routes addressing one actor; the first matching pattern wins. */
const ACTOR_ROUTES: ReadonlyArray<readonly [RegExp, ActorRoute]> = [
  [/^\/api\/actors\/([^/]+)\/([^/]+)\/timeline$/, "timeline"],
  [/^\/api\/actors\/([^/]+)\/([^/]+)\/view$/, "view"],
  [/^\/api\/actors\/([^/]+)\/([^/]+)\/actions$/, "action"],
  [/^\/api\/actors\/([^/]+)\/([^/]+)$/, "inspect"],
  [/^\/actors\/([^/]+)\/([^/]+)\/ws$/, "ws"],
];

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/** Routes with a fixed path. */
const FIXED_ROUTES: ReadonlyMap<string, "list" | "types"> = new Map([
  ["/api/actors", "list"],
  ["/api/actors/", "list"],
  ["/api/actors/types", "types"],
]);

function matchActorRoute(path: string): RouteMatch | null {
  for (const [pattern, route] of ACTOR_ROUTES) {
    const found = pattern.exec(path);
    const rawType = found?.[1];
    const rawId = found?.[2];
    if (rawType !== undefined && rawId !== undefined) return { route, rawType, rawId };
  }
  return null;
}

function matchRoute(path: string): RouteMatch {
  const fixed = FIXED_ROUTES.get(path);
  if (fixed !== undefined) return { route: fixed };
  return matchActorRoute(path) ?? { route: isApiPath(path) ? "unknown" : "ui" };
}

/** Audit fields for a match: decoded (when decodable) and truncated actor coordinates. */
function routeInfo(match: RouteMatch): RouteInfo {
  if (!("rawType" in match)) return { route: match.route };
  const actorType = decodeSegment(match.rawType);
  const actorId = decodeSegment(match.rawId);
  return {
    route: match.route,
    ...(actorType === null ? {} : { actorType: actorType.slice(0, MAX_TYPE_LENGTH) }),
    ...(actorId === null ? {} : { actorId: actorId.slice(0, MAX_ID_LENGTH) }),
  };
}

/** Apply `f` without introducing a Promise when `value` is already available. */
function andThen<T, U>(value: T | Promise<T>, f: (t: T) => U | Promise<U>): U | Promise<U> {
  return value instanceof Promise ? value.then(f) : f(value);
}

// --- Middleware ---

export interface StudioOptions {
  /** Access signing keys. Default: the team's published certs. */
  access?: AccessDeps;
  /** Audit sink. Default: one JSON line on console.log (Workers Logs). */
  log?: (event: StudioAuditEvent) => void;
}

export type StudioHandler = (
  request: Request,
  env: Record<string, unknown>,
  ctx: ExecutionContext,
) => Response | Promise<Response> | null;

function consoleAudit(event: StudioAuditEvent): void {
  console.log(JSON.stringify(event));
}

/**
 * Build the studio middleware. It returns a Response if the request matches /__studio or /__studio/*,
 * or null if the request should be handled by the user's normal routing.
 */
export function createActorKitStudio(options: StudioOptions = {}): StudioHandler {
  const access = options.access ?? remoteAccessKeys;
  const log = options.log ?? consoleAudit;

  return (request, env, _ctx) => {
    const url = new URL(request.url);
    const path = studioSubpath(url.pathname);
    if (path === null) return null;

    const startedAt = Date.now();
    const match = matchRoute(path);
    const info = routeInfo(match);
    let principal: StudioPrincipal | null = null;

    const finish = (response: Response): Response => {
      log({
        event: "studio.request",
        principal: principal?.kind ?? "anonymous",
        ...(principal === null ? {} : { subject: principal.subject }),
        method: request.method,
        ...info,
        status: response.status,
        durationMs: Date.now() - startedAt,
        outcome: outcomeOf(response.status),
      });
      return response;
    };

    // Auth before anything else, so unauthenticated callers cannot probe routes.
    const handled = andThen(authenticateStudio(request, url, env, access), (auth) => {
      if (!auth.ok) return jsonError(auth.status, auth.error);
      principal = auth.principal;
      return route({ request, path, url, env, principal: auth.principal }, match);
    });
    return andThen(handled, finish);
  };
}

/** Studio middleware with the default options (Access certs, console audit). */
export const actorKitStudio: StudioHandler = createActorKitStudio();

/** Everything a route handler may need about the request. */
interface StudioRequest {
  request: Request;
  path: string;
  url: URL;
  env: Record<string, unknown>;
  principal: StudioPrincipal;
}

type ActorHandler = (req: StudioRequest, rawType: string, rawId: string) => Response | Promise<Response>;

const ACTOR_HANDLERS: Record<ActorRoute, ActorHandler> = {
  inspect: handleInspect,
  timeline: handleTimeline,
  view: handleView,
  action: routeAction,
  ws: handleStudioWebSocket,
};

const OTHER_HANDLERS: Record<Exclude<StudioRoute, ActorRoute>, (req: StudioRequest) => Response | Promise<Response>> = {
  list: (req) => handleListActors(req.url, req.env),
  types: (req) => handleActorTypes(req.env),
  unknown: (req) => jsonError(404, `Unknown studio API route: ${req.path}`),
  ui: (req) => serveUi(req.path),
};

/** Actions are the only POST route (they check their own method), and the only route that changes an actor. */
function methodRefusal(req: StudioRequest, match: RouteMatch): Response | null {
  const method = req.request.method;
  if (match.route === "action" || method === "GET" || method === "HEAD") return null;
  return jsonError(405, `Method ${method} not allowed`, { Allow: ALLOWED_METHODS });
}

/** Agents only ever see hashed callers; without the key the DO could not hash, so refuse up front. */
function agentRefusal(req: StudioRequest): Response | null {
  const hashKey = req.env["STUDIO_CALLER_HASH_KEY"];
  if (req.principal.kind !== "agent" || (typeof hashKey === "string" && hashKey !== "")) return null;
  return jsonError(503, "Studio is not configured for agents: set STUDIO_CALLER_HASH_KEY");
}

function route(req: StudioRequest, match: RouteMatch): Response | Promise<Response> {
  const refusal = methodRefusal(req, match) ?? agentRefusal(req);
  if (refusal !== null) return refusal;
  if ("rawType" in match) return ACTOR_HANDLERS[match.route](req, match.rawType, match.rawId);
  return OTHER_HANDLERS[match.route](req);
}

/** Agents get hashed callers; people (and dev) use the DO's default human view. */
function viewerArg(principal: StudioPrincipal): { viewer: "agent" } | Record<string, never> {
  return principal.kind === "agent" ? { viewer: "agent" } : {};
}

/** Serve an embedded asset; any non-asset path falls back to the SPA shell (client-side routes). */
function serveUi(path: string): Response {
  // "", "/" and client-side routes are not assets, so they get the shell; unknown /assets/* do not.
  const asset = getAsset(path) ?? (path.startsWith("/assets/") ? null : getAsset("/index.html"));
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

function handleInspect(
  { env, principal }: StudioRequest,
  rawType: string,
  rawId: string,
): Response | Promise<Response> {
  const params = parseActorParams(rawType, rawId);
  if (!params.ok) return params.response;

  const actor = resolveActor(env, params.value);
  if (actor instanceof Response) return actor;

  // People keep the zero-argument call; only agents pass a viewer.
  const args = principal.kind === "agent" ? [viewerArg(principal)] : [];
  return withExistingActor(env, actor, params.value, () => asyncJson(() => callRpc(actor.stub, "__inspect", ...args)));
}

function handleTimeline(
  { url, env, principal }: StudioRequest,
  rawType: string,
  rawId: string,
): Response | Promise<Response> {
  const params = parseActorParams(rawType, rawId);
  if (!params.ok) return params.response;

  const query = parseQuery(TimelineQuery, url, ["limit", "before"]);
  if (!query.ok) return query.response;

  const actor = resolveActor(env, params.value);
  if (actor instanceof Response) return actor;

  return withExistingActor(env, actor, params.value, () =>
    asyncJson(() => callRpc(actor.stub, "__getTimeline", { ...query.value, ...viewerArg(principal) })),
  );
}

function handleView(
  { url, env, principal }: StudioRequest,
  rawType: string,
  rawId: string,
): Response | Promise<Response> {
  const params = parseActorParams(rawType, rawId);
  if (!params.ok) return params.response;

  const query = parseQuery(ViewQuery, url, ["role", "caller"]);
  if (!query.ok) return query.response;

  const actor = resolveActor(env, params.value);
  if (actor instanceof Response) return actor;

  return withExistingActor(env, actor, params.value, () =>
    asyncJson(() => callRpc(actor.stub, "__getView", { ...query.value, ...viewerArg(principal) })),
  );
}

function handleStudioWebSocket(
  { request, env, principal }: StudioRequest,
  rawType: string,
  rawId: string,
): Response | Promise<Response> {
  // RFC 6455 §4.2.1: the Upgrade value is a case-insensitive token.
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return jsonError(426, "Expected WebSocket", { Upgrade: "websocket" });
  }

  const params = parseActorParams(rawType, rawId);
  if (!params.ok) return params.response;

  const actor = resolveActor(env, params.value);
  if (actor instanceof Response) return actor;

  return withExistingActor(env, actor, params.value, () => {
    // Stamp __studio identity headers (set() replaces any inbound ones) and forward to DO
    const stampedRequest = new Request(request);
    stampedRequest.headers.set(CALLER_ID_HEADER, "__studio");
    stampedRequest.headers.set(CALLER_TYPE_HEADER, "service");
    stampedRequest.headers.set(STUDIO_VIEWER_HEADER, principal.kind === "agent" ? "agent" : "human");
    return actor.stub.fetch(stampedRequest);
  });
}

/** Run `use` only once the registry confirms the actor exists; never contacts the actor DO otherwise. */
// --- Actions (mutate scope) ---

const MAX_ACTION_BODY = 4096;

/** Every Studio action, by name: the actor RPC it calls and its arguments. */
const ActionBody = z.union([
  z.object({ action: z.literal("redrive"), effectId: z.string().min(1).max(64) }).strict(),
  z.object({ action: z.literal("fireTimer"), key: z.string().min(1).max(256) }).strict(),
  z.object({ action: z.literal("restore"), toSeq: z.number().int().positive() }).strict(),
]);
type ActionBody = z.infer<typeof ActionBody>;

const ActionReply = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: z.string() })]);

function actionRpc(body: ActionBody): { method: string; args: unknown } {
  switch (body.action) {
    case "redrive":
      return { method: "__redrive", args: { effectId: body.effectId } };
    case "fireTimer":
      return { method: "__fireTimer", args: { key: body.key } };
    case "restore":
      return { method: "__restore", args: { toSeq: body.toSeq } };
  }
}

async function readActionBody(
  request: Request,
): Promise<{ ok: true; value: ActionBody } | { ok: false; response: Response }> {
  const text = await request.text();
  if (text.length > MAX_ACTION_BODY) return { ok: false, response: jsonError(413, "Action body too large") };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, response: jsonError(400, "Action body must be JSON") };
  }
  const parsed = ActionBody.safeParse(json);
  if (!parsed.success) {
    return { ok: false, response: jsonError(400, `Invalid action: ${describeIssues(parsed.error)}`) };
  }
  return { ok: true, value: parsed.data };
}

/** POST .../actions only: other methods get 405 with Allow: POST. */
function routeAction(req: StudioRequest, rawType: string, rawId: string): Response | Promise<Response> {
  if (req.request.method !== "POST") {
    return jsonError(405, `Method ${req.request.method} not allowed`, { Allow: "POST" });
  }
  return handleAction(req, rawType, rawId);
}

async function handleAction(
  { request, env, principal }: StudioRequest,
  rawType: string,
  rawId: string,
): Promise<Response> {
  if (!hasScope(principal, "mutate")) {
    return jsonError(403, "Studio actions need the mutate scope (an admin, or dev on localhost)");
  }
  const params = parseActorParams(rawType, rawId);
  if (!params.ok) return params.response;
  const body = await readActionBody(request);
  if (!body.ok) return body.response;
  const actor = resolveActor(env, params.value);
  if (actor instanceof Response) return actor;

  const { method, args } = actionRpc(body.value);
  return withExistingActor(env, actor, params.value, async () => {
    try {
      const reply = ActionReply.parse(await callRpc(actor.stub, method, args));
      return reply.ok ? Response.json({ ok: true }) : jsonError(409, reply.error);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  });
}

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
