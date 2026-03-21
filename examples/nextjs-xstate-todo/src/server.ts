/**
 * Worker entrypoint — routes requests to the Todo Durable Object.
 * Uses direct DO stub access instead of createActorKitRouter.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { getCallerFromRequest } from "../../../packages/core/src/auth";
import { Todo } from "./todo.server";
import type { Env } from "./types";

export { Todo };

export default class Worker extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (!url.pathname.startsWith("/api/")) {
      return new Response("API powered by ActorKit");
    }

    // Parse /api/{actorType}/{actorId}
    const parts = url.pathname.split("/").filter(Boolean);
    const [, actorType, actorId] = parts;

    if (!actorType || !actorId) {
      return new Response("Invalid path", { status: 400 });
    }

    // Get the DO namespace by actor type
    const nsKey = actorType.toUpperCase();
    const namespace = this.env[nsKey];
    if (!namespace || typeof namespace !== "object" || !("idFromName" in namespace)) {
      return new Response(`Unknown actor type: ${actorType}`, { status: 404 });
    }

    const ns = namespace as DurableObjectNamespace;
    const stub = ns.get(ns.idFromName(actorId));

    // Validate caller from JWT
    let caller;
    try {
      caller = await getCallerFromRequest(
        request, actorType, actorId, this.env.ACTOR_KIT_SECRET
      );
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }

    // Spawn actor (idempotent)
    const actorStub = stub as unknown as {
      spawn(props: { actorType: string; actorId: string; caller: typeof caller; input: Record<string, unknown> }): Promise<void>;
      getSnapshot(caller: typeof caller): Promise<{ checksum: string; snapshot: unknown }>;
      send(event: { type: string; caller: typeof caller }): void;
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
    if (request.headers.get("Upgrade") === "websocket") {
      return actorStub.fetch(request);
    }

    // GET — return snapshot
    if (request.method === "GET") {
      const result = await actorStub.getSnapshot(caller);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST — send event
    if (request.method === "POST") {
      const event = await request.json() as { type: string };
      actorStub.send({ ...event, caller });
      return new Response(JSON.stringify({ success: true }));
    }

    return new Response("Method not allowed", { status: 405 });
  }
}
