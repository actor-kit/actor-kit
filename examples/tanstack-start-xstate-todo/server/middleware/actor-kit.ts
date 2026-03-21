import { getCallerFromRequest } from "@actor-kit/core";
import type { Caller } from "@actor-kit/core";
import { getActorRuntimeEnv } from "../../src/server-env";

type MiddlewareEvent = {
  req: Request;
};

export default async function actorKitMiddleware(event: MiddlewareEvent) {
  const url = new URL(event.req.url);

  if (url.pathname === "/health") {
    return new Response("ok");
  }

  if (!url.pathname.startsWith("/api/")) {
    return undefined;
  }

  const env = getActorRuntimeEnv();

  // Parse /api/{actorType}/{actorId}
  const parts = url.pathname.split("/").filter(Boolean);
  const [, actorType, actorId] = parts;

  if (!actorType || !actorId) {
    return new Response("Invalid path", { status: 400 });
  }

  // Get the DO namespace by actor type
  const nsKey = actorType.toUpperCase();
  const namespace = env[nsKey];
  if (!namespace || typeof namespace !== "object" || !("idFromName" in namespace)) {
    return new Response(`Unknown actor type: ${actorType}`, { status: 404 });
  }

  const ns = namespace as import("@cloudflare/workers-types").DurableObjectNamespace;
  const stub = ns.get(ns.idFromName(actorId));

  // Validate caller from JWT
  let caller;
  try {
    caller = await getCallerFromRequest(
      event.req, actorType, actorId, env.ACTOR_KIT_SECRET
    );
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const actorStub = stub as unknown as {
    spawn(props: { actorType: string; actorId: string; caller: Caller; input: Record<string, unknown> }): Promise<void>;
    getSnapshot(caller: Caller): Promise<{ checksum: string; snapshot: unknown }>;
    send(event: { type: string; caller: Caller }): void;
    fetch(request: Request): Promise<Response>;
  };

  // Parse input from query params
  let input: Record<string, unknown> = {};
  const inputParam = url.searchParams.get("input");
  if (inputParam) {
    try { input = JSON.parse(inputParam); } catch { /* ignore */ }
  }

  await actorStub.spawn({ actorType, actorId, caller, input });

  // WebSocket upgrade
  if (event.req.headers.get("Upgrade") === "websocket") {
    return actorStub.fetch(event.req);
  }

  // GET — return snapshot
  if (event.req.method === "GET") {
    const result = await actorStub.getSnapshot(caller);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // POST — send event
  if (event.req.method === "POST") {
    const body = await event.req.json() as { type: string };
    actorStub.send({ ...body, caller });
    return new Response(JSON.stringify({ success: true }));
  }

  return new Response("Method not allowed", { status: 405 });
}
