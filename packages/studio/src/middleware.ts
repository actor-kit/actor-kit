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

// Identity header constants (duplicated from @actor-kit/worker to avoid cloudflare:workers dependency)
const CALLER_ID_HEADER = "X-Actor-Kit-Caller-Id";
const CALLER_TYPE_HEADER = "X-Actor-Kit-Caller-Type";

// --- Types ---

interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): Record<string, unknown>;
}

interface StudioRegistryStub {
  listActors(opts: { type?: string; search?: string; limit?: number; offset?: number }): Promise<
    Array<{
      actorType: string;
      actorId: string;
      lastActiveAt: number;
      version: number | null;
      connectionCount: number;
    }>
  >;
  getActorTypes(): Promise<string[]>;
}

const STUDIO_PREFIX = "/__studio";

// --- Helpers ---

/** Check if a value looks like a DurableObjectNamespace. */
function isDONamespace(val: unknown): val is DONamespace {
  return (
    typeof val === "object" &&
    val !== null &&
    "idFromName" in val &&
    typeof (val as Record<string, unknown>)["idFromName"] === "function" &&
    "get" in val &&
    typeof (val as Record<string, unknown>)["get"] === "function"
  );
}

/** Find the StudioRegistry namespace in env. */
function findRegistryNamespace(env: Record<string, unknown>): DONamespace | null {
  // Check for the static marker
  for (const val of Object.values(env)) {
    if (
      isDONamespace(val) &&
      typeof val === "object" &&
      val !== null &&
      "__actorKitStudioRegistry" in (val.constructor ?? {})
    ) {
      return val;
    }
  }
  // Fall back to well-known binding name
  const binding: unknown = env["STUDIO_REGISTRY"];
  if (isDONamespace(binding)) return binding;
  return null;
}

/** Resolve a StudioRegistry stub (singleton). */
function getRegistryStub(env: Record<string, unknown>): StudioRegistryStub | null {
  const ns = findRegistryNamespace(env);
  if (ns === null) return null;
  try {
    const doId = ns.idFromName("registry");
    return ns.get(doId) as unknown as StudioRegistryStub;
  } catch {
    return null;
  }
}

/** Resolve an actor DO stub by type and ID. */
function resolveActorStub(
  actorType: string,
  actorId: string,
  env: Record<string, unknown>,
): Record<string, unknown> | null {
  // Try binding name: actorType → ACTOR_TYPE (uppercase with underscores)
  const bindingName = actorType.toUpperCase().replace(/-/g, "_");
  const ns: unknown = env[bindingName];
  if (!isDONamespace(ns)) return null;

  try {
    const doId = ns.idFromName(actorId);
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

  // SPA fallback — serve index.html for all other studio routes
  return new Response("<!-- Actor Kit Studio -->", {
    headers: { "Content-Type": "text/html" },
  });
}

// --- Auth ---

function checkAuth(request: Request, env: Record<string, unknown>): Response | null {
  const secret = env["ACTOR_KIT_STUDIO_SECRET"];

  // No secret configured
  if (secret === undefined || secret === "") {
    // In dev (localhost), allow without auth
    const url = new URL(request.url);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return null;
    }
    return new Response(
      "Studio is not configured. Set ACTOR_KIT_STUDIO_SECRET via `wrangler secret put ACTOR_KIT_STUDIO_SECRET`.",
      { status: 403 },
    );
  }

  // Check header
  const key = request.headers.get("X-Actor-Kit-Studio-Key");
  if (key !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

// --- Route handlers ---

function handleListActors(url: URL, env: Record<string, unknown>): Response {
  const registry = getRegistryStub(env);
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

  // Return a promise-based Response (Cloudflare Workers support async responses)
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const actors = await registry.listActors(opts);
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ actors })));
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ actors: [], error: message })));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function handleActorTypes(env: Record<string, unknown>): Response {
  const registry = getRegistryStub(env);
  if (registry === null) {
    return Response.json({ types: [], error: "StudioRegistry not found in env bindings" }, { status: 503 });
  }

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const types = await registry.getActorTypes();
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ types })));
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ types: [], error: message })));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function handleInspect(actorType: string, actorId: string, env: Record<string, unknown>): Response {
  const stub = resolveActorStub(actorType, actorId, env);
  if (stub === null) {
    return Response.json({ error: `Actor type "${actorType}" not found in env bindings` }, { status: 404 });
  }

  if (typeof stub["__inspect"] !== "function") {
    return Response.json({ error: "Actor does not support __inspect()" }, { status: 501 });
  }

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const inspectFn = stub["__inspect"] as () => Promise<unknown>;
          const result = await inspectFn();
          controller.enqueue(new TextEncoder().encode(JSON.stringify(result)));
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: message })));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function handleTimeline(actorType: string, actorId: string, url: URL, env: Record<string, unknown>): Response {
  const stub = resolveActorStub(actorType, actorId, env);
  if (stub === null) {
    return Response.json({ error: `Actor type "${actorType}" not found in env bindings` }, { status: 404 });
  }

  if (typeof stub["__getTimeline"] !== "function") {
    return Response.json({ error: "Actor does not support __getTimeline()" }, { status: 501 });
  }

  const timelineOpts: { limit?: number; before?: number } = {};
  if (url.searchParams.has("limit")) timelineOpts.limit = Number(url.searchParams.get("limit"));
  if (url.searchParams.has("before")) timelineOpts.before = Number(url.searchParams.get("before"));

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const timelineFn = stub["__getTimeline"] as (opts?: { limit?: number; before?: number }) => Promise<unknown>;
          const result = await timelineFn(timelineOpts);
          controller.enqueue(new TextEncoder().encode(JSON.stringify(result)));
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: message })));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function handleStudioWebSocket(
  request: Request,
  actorType: string,
  actorId: string,
  env: Record<string, unknown>,
): Response {
  // Verify WebSocket upgrade
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const stub = resolveActorStub(actorType, actorId, env);
  if (stub === null) {
    return new Response(`Actor type "${actorType}" not found in env bindings`, { status: 404 });
  }

  // Stamp __studio identity headers and forward to DO
  const stampedRequest = new Request(request);
  // Scrub any existing identity headers
  stampedRequest.headers.delete(CALLER_ID_HEADER);
  stampedRequest.headers.delete(CALLER_TYPE_HEADER);
  // Set studio identity
  stampedRequest.headers.set(CALLER_ID_HEADER, "__studio");
  stampedRequest.headers.set(CALLER_TYPE_HEADER, "service");

  // Forward the WebSocket upgrade to the DO
  const fetchFn = stub["fetch"] as ((request: Request) => Promise<Response>) | undefined;
  if (typeof fetchFn !== "function") {
    return new Response("Actor does not support fetch()", { status: 501 });
  }

  // Return a promise — CF Workers handles async Response returns from fetch
  // We need to use a workaround since the function signature returns Response (not Promise<Response>)
  // The DO's fetch() returns a 101 response with the WebSocket
  return fetchFn.call(stub, stampedRequest) as unknown as Response;
}
