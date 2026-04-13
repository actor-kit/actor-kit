/**
 * actorKitStudio() — middleware that intercepts /__studio/* routes.
 *
 * Handles:
 * - Auth (no auth in dev, secret key in prod)
 * - Actor listing from StudioRegistry
 * - Actor inspection via __inspect() RPC
 * - Timeline retrieval via __getTimeline() RPC
 * - WebSocket upgrade for live studio connections
 * - Serving the bundled SPA
 */

import { getAsset } from "./ui-assets";

// Identity header constants (duplicated from @actor-kit/worker to avoid cloudflare:workers dependency)
const CALLER_ID_HEADER = "X-Actor-Kit-Caller-Id";
const CALLER_TYPE_HEADER = "X-Actor-Kit-Caller-Type";

const STUDIO_PREFIX = "/__studio";

// --- Helpers ---

/** Runtime check: does this value look like a DurableObjectNamespace? */
function looksLikeDONamespace(val: unknown): boolean {
  return typeof val === "object" && val !== null && "idFromName" in val && "get" in val;
}

/** Check if a string looks like a hex DO ID (64 hex chars). */
function isHexId(id: string): boolean {
  return /^[0-9a-f]{64}$/i.test(id);
}

/** Resolve a DO stub from an env binding. Accepts both human names and hex DO IDs. */
function resolveStub(env: Record<string, unknown>, bindingName: string, actorId: string): DurableObjectStub | null {
  const binding: unknown = env[bindingName];
  if (!looksLikeDONamespace(binding)) return null;
  try {
    const ns = binding as DurableObjectNamespace;
    // If the actorId is a hex DO ID, use idFromString to avoid double-hashing
    const doId = isHexId(actorId) ? ns.idFromString(actorId) : ns.idFromName(actorId);
    return ns.get(doId);
  } catch {
    return null;
  }
}

// --- Middleware ---

/**
 * Studio middleware. Returns a Response if the request matches /__studio/*,
 * or null if the request should be handled by the user's normal routing.
 */
export function actorKitStudio(
  request: Request,
  env: Record<string, unknown>,
  _ctx: ExecutionContext,
): Response | null {
  const url = new URL(request.url);

  if (!url.pathname.startsWith(STUDIO_PREFIX)) {
    return null;
  }

  // Auth check
  const authResult = checkAuth(request, env);
  if (authResult !== null) return authResult;

  const path = url.pathname.slice(STUDIO_PREFIX.length);

  // API routes
  if (path === "/api/actors" || path === "/api/actors/") {
    return handleListActors(url, env);
  }

  if (path === "/api/actors/types") {
    return handleActorTypes(env);
  }

  // Match /api/actors/:type/:id/timeline
  const timelineMatch = path.match(/^\/api\/actors\/([^/]+)\/([^/]+)\/timeline$/);
  if (timelineMatch?.[1] !== undefined && timelineMatch[2] !== undefined) {
    return handleTimeline(timelineMatch[1], decodeURIComponent(timelineMatch[2]), url, env);
  }

  // Match /api/actors/:type/:id
  const actorMatch = path.match(/^\/api\/actors\/([^/]+)\/([^/]+)$/);
  if (actorMatch?.[1] !== undefined && actorMatch[2] !== undefined) {
    return handleInspect(actorMatch[1], decodeURIComponent(actorMatch[2]), env);
  }

  // Match /actors/:type/:id/ws — WebSocket upgrade
  const wsMatch = path.match(/^\/actors\/([^/]+)\/([^/]+)\/ws$/);
  if (wsMatch?.[1] !== undefined && wsMatch[2] !== undefined) {
    return handleStudioWebSocket(request, wsMatch[1], decodeURIComponent(wsMatch[2]), env);
  }

  // Serve embedded UI assets (SPA with fallback to index.html)
  const asset = getAsset(path || "/index.html");
  if (asset) {
    return new Response(asset.body, {
      headers: {
        "Content-Type": asset.contentType,
        "Cache-Control": asset.contentType === "text/html" ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  }

  return new Response("Not found", { status: 404 });
}

// --- Auth ---

function checkAuth(request: Request, env: Record<string, unknown>): Response | null {
  const secret = env["ACTOR_KIT_STUDIO_SECRET"];

  if (secret === undefined || secret === "") {
    const url = new URL(request.url);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return null;
    }
    return new Response(
      "Studio is not configured. Set ACTOR_KIT_STUDIO_SECRET via `wrangler secret put ACTOR_KIT_STUDIO_SECRET`.",
      { status: 403 },
    );
  }

  const key = request.headers.get("X-Actor-Kit-Studio-Key");
  if (key !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

// --- Route handlers ---

/**
 * Call an RPC method on a DurableObjectStub by name.
 * CF Workers RPC methods are available on the stub proxy at runtime.
 */
function callRpc(stub: DurableObjectStub, method: string, ...args: unknown[]): Promise<unknown> {
  const stubRecord: Record<string, unknown> = stub;
  const fn = stubRecord[method];
  if (typeof fn !== "function") {
    throw new Error(`RPC method "${method}" not found on stub`);
  }
  return (fn as (...a: unknown[]) => Promise<unknown>)(...args);
}

/** Stream a JSON response from an async operation. */
function jsonStream(fn: () => Promise<unknown>, fallback: unknown): Response {
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const result = await fn();
          controller.enqueue(new TextEncoder().encode(JSON.stringify(result)));
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ ...((fallback ?? {}) as Record<string, unknown>), error: message }),
            ),
          );
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function handleListActors(url: URL, env: Record<string, unknown>): Response {
  const registry = resolveStub(env, "STUDIO_REGISTRY", "registry");
  if (registry === null) {
    return Response.json({ actors: [], error: "StudioRegistry not found in env bindings" }, { status: 503 });
  }

  const opts: { type?: string; search?: string; limit?: number; offset?: number } = {};
  const typeParam = url.searchParams.get("type");
  if (typeParam !== null) opts.type = typeParam;
  const searchParam = url.searchParams.get("search");
  if (searchParam !== null) opts.search = searchParam;
  if (url.searchParams.has("limit")) opts.limit = Number(url.searchParams.get("limit"));
  if (url.searchParams.has("offset")) opts.offset = Number(url.searchParams.get("offset"));

  return jsonStream(async () => ({ actors: await callRpc(registry, "listActors", opts) }), { actors: [] });
}

function handleActorTypes(env: Record<string, unknown>): Response {
  const registry = resolveStub(env, "STUDIO_REGISTRY", "registry");
  if (registry === null) {
    return Response.json({ types: [], error: "StudioRegistry not found in env bindings" }, { status: 503 });
  }

  return jsonStream(async () => ({ types: await callRpc(registry, "getActorTypes") }), { types: [] });
}

function handleInspect(actorType: string, actorId: string, env: Record<string, unknown>): Response {
  const bindingName = actorType.toUpperCase().replace(/-/g, "_");
  const stub = resolveStub(env, bindingName, actorId);
  if (stub === null) {
    return Response.json({ error: `Actor type "${actorType}" not found in env bindings` }, { status: 404 });
  }

  return jsonStream(() => callRpc(stub, "__inspect"), {});
}

function handleTimeline(actorType: string, actorId: string, url: URL, env: Record<string, unknown>): Response {
  const bindingName = actorType.toUpperCase().replace(/-/g, "_");
  const stub = resolveStub(env, bindingName, actorId);
  if (stub === null) {
    return Response.json({ error: `Actor type "${actorType}" not found in env bindings` }, { status: 404 });
  }

  const timelineOpts: { limit?: number; before?: number } = {};
  if (url.searchParams.has("limit")) timelineOpts.limit = Number(url.searchParams.get("limit"));
  if (url.searchParams.has("before")) timelineOpts.before = Number(url.searchParams.get("before"));

  return jsonStream(() => callRpc(stub, "__getTimeline", timelineOpts), { entries: [] });
}

function handleStudioWebSocket(
  request: Request,
  actorType: string,
  actorId: string,
  env: Record<string, unknown>,
): Response {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const bindingName = actorType.toUpperCase().replace(/-/g, "_");
  const stub = resolveStub(env, bindingName, actorId);
  if (stub === null) {
    return new Response(`Actor type "${actorType}" not found in env bindings`, { status: 404 });
  }

  // Stamp __studio identity headers and forward to DO
  const stampedRequest = new Request(request);
  stampedRequest.headers.delete(CALLER_ID_HEADER);
  stampedRequest.headers.delete(CALLER_TYPE_HEADER);
  stampedRequest.headers.set(CALLER_ID_HEADER, "__studio");
  stampedRequest.headers.set(CALLER_TYPE_HEADER, "service");

  // stub.fetch returns Promise<Response> — CF Workers runtime accepts this
  return stub.fetch(stampedRequest) as unknown as Response;
}
