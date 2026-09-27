/**
 * Minimal Worker for Studio E2E testing.
 * Exports a Counter actor with studio enabled + studio middleware.
 */

import { nullable, schema, string, uint32, view } from "@actor-kit/core";
import { actorKitStudio, StudioRegistry } from "@actor-kit/studio";
import { createActorClass, defineActor, message, withCallerIdentity } from "@actor-kit/worker";
import { z } from "zod";

// --- Counter actor ---

type CounterState = { count: number; lastUpdatedBy: string | null };

const CounterViewSchema = schema({ count: uint32, lastUpdatedBy: nullable(string) });

const CounterContract = defineActor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastUpdatedBy: null }),
  roles: { user: () => true },
  messages: {
    INCREMENT: message(z.object({}), (state: CounterState, _payload, { caller }) => ({
      ...state,
      count: state.count + 1,
      lastUpdatedBy: caller,
    })),
  },
  views: {
    user: view.shared(CounterViewSchema, (state: CounterState) => ({
      count: state.count,
      lastUpdatedBy: state.lastUpdatedBy,
    })),
  },
  studio: { enabled: true },
});

export const Counter = createActorClass(CounterContract);
export { StudioRegistry };

// --- Worker fetch ---

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
    // Studio middleware first
    const studioResponse = actorKitStudio(request, env, ctx);
    if (studioResponse) return studioResponse;

    const url = new URL(request.url);

    // Seed endpoint: creates an actor and sends messages
    if (url.pathname === "/seed" && request.method === "POST") {
      const body = (await request.json()) as { actorId: string; count: number };
      const ns = env["COUNTER"] as DurableObjectNamespace;
      const stub = ns.get(ns.idFromName(body.actorId));

      // Spawn via RPC
      const spawnFn = (stub as Record<string, unknown>)["spawn"];
      if (typeof spawnFn === "function") {
        await (spawnFn as (input: Record<string, unknown>) => Promise<void>)({
          actorId: body.actorId,
          caller: "e2e-test",
          callerType: "user",
          input: {},
        });
      }

      // Increment N times via RPC
      const sendFn = (stub as Record<string, unknown>)["send"];
      if (typeof sendFn === "function") {
        for (let i = 0; i < body.count; i++) {
          await (sendFn as (c: string, t: string, e: Record<string, unknown>) => Promise<unknown>)("e2e-test", "user", {
            type: "INCREMENT",
          });
        }
      }

      return Response.json({ ok: true, actorId: body.actorId, count: body.count });
    }

    // WebSocket upgrade for counter (for testing with real clients).
    // Caller identity comes from ?caller=<id> query (defaults to "e2e-user").
    if (url.pathname.startsWith("/api/counter/") && request.headers.get("Upgrade") === "websocket") {
      const actorId = url.pathname.split("/")[3];
      if (!actorId) return new Response("Missing actor ID", { status: 400 });

      const callerId = url.searchParams.get("caller") ?? "e2e-user";

      const ns = env["COUNTER"] as DurableObjectNamespace;
      const stub = ns.get(ns.idFromName(actorId));
      const stampedRequest = withCallerIdentity(request, { callerId, callerType: "user" });
      return stub.fetch(stampedRequest);
    }

    // RPC: send an INCREMENT to the actor as a specific caller (so it shows up in timeline).
    if (url.pathname.startsWith("/send/") && request.method === "POST") {
      const actorId = url.pathname.split("/")[2];
      if (!actorId) return new Response("Missing actor ID", { status: 400 });
      const body = (await request.json()) as { caller?: string };
      const callerId = body.caller ?? "e2e-test";

      const ns = env["COUNTER"] as DurableObjectNamespace;
      const stub = ns.get(ns.idFromName(actorId));
      const sendFn = (stub as Record<string, unknown>)["send"];
      if (typeof sendFn === "function") {
        await (sendFn as (c: string, t: string, e: Record<string, unknown>) => Promise<unknown>)(callerId, "user", {
          type: "INCREMENT",
        });
      }
      return Response.json({ ok: true });
    }

    return new Response("Studio E2E test worker", { status: 200 });
  },
};
