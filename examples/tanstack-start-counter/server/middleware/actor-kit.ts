// Nitro middleware: intercepts /api/* requests and routes to Durable Objects.
// Uses withCallerIdentity to stamp verified caller identity before forwarding.

import { withCallerIdentity } from "@actor-kit/worker/testing";
import { getActorRuntimeEnv, isActorNamespace } from "../../src/server-env";

interface MiddlewareEvent {
  req: Request;
}

export default async function actorKitMiddleware(event: MiddlewareEvent) {
  const url = new URL(event.req.url);

  if (!url.pathname.startsWith("/api/")) {
    return undefined;
  }

  const env = getActorRuntimeEnv();

  // Parse /api/{actorType}/{actorId}
  const parts = url.pathname.split("/").filter(Boolean);
  const [, actorType, actorId] = parts;

  if (!actorType || !actorId) {
    return new Response("Invalid path — expected /api/{actorType}/{actorId}", { status: 400 });
  }

  // Resolve DO namespace from env binding (COUNTER binding for "counter" type)
  const nsKey = actorType.toUpperCase();
  const namespace: unknown = env[nsKey];
  if (!isActorNamespace(namespace)) {
    return new Response(`Unknown actor type: ${actorType}`, { status: 404 });
  }

  const doId = namespace.idFromName(actorId);
  const stub = namespace.get(doId);

  // Authenticate the caller.
  // PRODUCTION: validate session cookie, OAuth token, or similar credential here.
  // This demo uses a query param for simplicity — NOT safe for production.
  const callerId =
    url.searchParams.get("callerId") ??
    `user-${crypto.randomUUID().slice(0, 8)}`;

  // Spawn idempotently with system credentials
  await stub.spawn({
    actorId,
    caller: "system",
    callerType: "service",
    input: {},
  });

  // WebSocket upgrade — stamp identity and forward to DO
  if (event.req.headers.get("Upgrade") === "websocket") {
    const stamped = withCallerIdentity(event.req, {
      callerId,
      callerType: "user",
    });
    return stub.fetch(stamped);
  }

  // GET — return snapshot
  if (event.req.method === "GET") {
    const result = await stub.getSnapshot(callerId, "user");
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // POST — send event
  if (event.req.method === "POST") {
    const body = (await event.req.json()) as Record<string, unknown>;
    await stub.send(callerId, "user", body);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
}
