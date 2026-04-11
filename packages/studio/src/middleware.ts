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

interface StudioEnv {
  ACTOR_KIT_STUDIO_SECRET?: string;
  [key: string]: unknown;
}

const STUDIO_PREFIX = "/__studio";

/**
 * Studio middleware. Returns a Response if the request matches /__studio/*,
 * or null if the request should be handled by the user's normal routing.
 */
export function actorKitStudio(request: Request, env: StudioEnv, ctx: ExecutionContext): Response | null {
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
    return handleListActors(url, env, ctx);
  }

  if (path === "/api/actors/types") {
    return handleActorTypes(env, ctx);
  }

  // Match /api/actors/:type/:id
  const actorMatch = path.match(/^\/api\/actors\/([^/]+)\/([^/]+)$/);
  if (actorMatch?.[1] !== undefined && actorMatch[2] !== undefined) {
    return handleInspect(actorMatch[1], decodeURIComponent(actorMatch[2]), env, ctx);
  }

  // Match /api/actors/:type/:id/timeline
  const timelineMatch = path.match(/^\/api\/actors\/([^/]+)\/([^/]+)\/timeline$/);
  if (timelineMatch?.[1] !== undefined && timelineMatch[2] !== undefined) {
    return handleTimeline(timelineMatch[1], decodeURIComponent(timelineMatch[2]), url, env, ctx);
  }

  // Match /actors/:type/:id/ws — WebSocket upgrade
  const wsMatch = path.match(/^\/actors\/([^/]+)\/([^/]+)\/ws$/);
  if (wsMatch?.[1] !== undefined && wsMatch[2] !== undefined) {
    return handleStudioWebSocket(request, wsMatch[1], decodeURIComponent(wsMatch[2]), env, ctx);
  }

  // SPA fallback — serve index.html for all other studio routes
  return new Response("<!-- Studio SPA placeholder -->", {
    headers: { "Content-Type": "text/html" },
  });
}

// --- Auth ---

function checkAuth(request: Request, env: StudioEnv): Response | null {
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

function handleListActors(_url: URL, _env: StudioEnv, _ctx: ExecutionContext): Response {
  // TODO: resolve StudioRegistry from env/ctx.exports and call listActors()
  return Response.json({ actors: [], message: "Not yet implemented" });
}

function handleActorTypes(_env: StudioEnv, _ctx: ExecutionContext): Response {
  // TODO: resolve StudioRegistry and call getActorTypes()
  return Response.json({ types: [], message: "Not yet implemented" });
}

function handleInspect(_actorType: string, _actorId: string, _env: StudioEnv, _ctx: ExecutionContext): Response {
  // TODO: resolve actor DO and call __inspect() RPC
  return Response.json({ message: "Not yet implemented" });
}

function handleTimeline(
  _actorType: string,
  _actorId: string,
  _url: URL,
  _env: StudioEnv,
  _ctx: ExecutionContext,
): Response {
  // TODO: resolve actor DO and call __getTimeline() RPC
  return Response.json({ entries: [], message: "Not yet implemented" });
}

function handleStudioWebSocket(
  _request: Request,
  _actorType: string,
  _actorId: string,
  _env: StudioEnv,
  _ctx: ExecutionContext,
): Response {
  // TODO: WebSocket upgrade with __studio caller identity
  return new Response("WebSocket upgrade not yet implemented", { status: 501 });
}
