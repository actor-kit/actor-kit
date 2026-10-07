/**
 * Studio middleware (actorKitStudio) against real Durable Objects.
 *
 * Calls the middleware directly inside workerd with the real env bindings
 * (COUNTER, STUDIO_REGISTRY), so routing, the registry, RPC and the studio
 * WebSocket all run for real.
 */
import { createExecutionContext, env, listDurableObjectIds } from "cloudflare:test";
import { actorKitStudio } from "@actor-kit/studio";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const STUDIO_KEY_HEADER = "X-Actor-Kit-Studio-Key";

function studioEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...env, ...extra };
}

async function studioFetch(
  path: string,
  init: { host?: string; headers?: Record<string, string>; method?: string; extraEnv?: Record<string, unknown> } = {},
): Promise<Response> {
  const host = init.host ?? "localhost";
  const request = new Request(`http://${host}${path}`, {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
  });
  const result = actorKitStudio(request, studioEnv(init.extraEnv), createExecutionContext());
  if (result === null) throw new Error(`middleware did not handle ${path}`);
  return await result;
}

/** Create a real actor through the runtime and wait for its registry entry. */
async function spawnCounter(actorId: string, increments = 0): Promise<void> {
  const stub = env.COUNTER.get(env.COUNTER.idFromName(actorId));
  await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
  for (let i = 0; i < increments; i++) {
    await stub.send("user-1", "user", { type: "INCREMENT", amount: 1 });
  }
  // Registry touches are fire-and-forget RPCs.
  await new Promise((r) => setTimeout(r, 100));
}

async function registryIds(): Promise<string[]> {
  const registry = env.STUDIO_REGISTRY.get(env.STUDIO_REGISTRY.idFromName("registry"));
  const actors = await registry.listActors({ type: "counter", limit: 1000 });
  return actors.map((a: { actorId: string }) => a.actorId);
}

async function counterHasStorage(actorId: string): Promise<boolean> {
  const hex = env.COUNTER.idFromName(actorId).toString();
  const ids = await listDurableObjectIds(env.COUNTER);
  return ids.some((id) => id.toString() === hex);
}

describe("Studio middleware (integration)", () => {
  describe("inspect route", () => {
    it("returns the state of an existing actor by name", async () => {
      const actorId = `mw-inspect-${Date.now()}`;
      await spawnCounter(actorId, 3);

      const res = await studioFetch(`/__studio/api/actors/counter/${actorId}`);
      expect(res.status).toBe(200);
      const body = await res.json<{ state: { count: number }; actorId: string }>();
      expect(body.state.count).toBe(3);
      expect(body.actorId).toBe(actorId);
    });

    it("returns the state of an existing actor by hex DO id", async () => {
      const actorId = `mw-inspect-hex-${Date.now()}`;
      await spawnCounter(actorId, 2);
      const hex = env.COUNTER.idFromName(actorId).toString();

      const res = await studioFetch(`/__studio/api/actors/counter/${hex}`);
      expect(res.status).toBe(200);
      const body = await res.json<{ state: { count: number } }>();
      expect(body.state.count).toBe(2);
    });

    it("looking up an unknown actor id is a JSON 404 and creates no phantom actor", async () => {
      const actorId = `mw-phantom-${Date.now()}`;

      const res = await studioFetch(`/__studio/api/actors/counter/${actorId}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("not found");

      await new Promise((r) => setTimeout(r, 100));
      expect(await counterHasStorage(actorId)).toBe(false);
      const hex = env.COUNTER.idFromName(actorId).toString();
      const ids = await registryIds();
      expect(ids).not.toContain(actorId);
      expect(ids).not.toContain(hex);
    });

    it("an actor type that is not a studio actor (the registry binding) is 404, not 500", async () => {
      const res = await studioFetch("/__studio/api/actors/studio-registry/registry");
      expect(res.status).toBe(404);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("not found");
    });

    it("a malformed percent-encoded id is 400, not a thrown URIError", async () => {
      const res = await studioFetch("/__studio/api/actors/counter/%E0%A4%A");
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(typeof body.error).toBe("string");
    });
  });

  describe("timeline route", () => {
    it("returns paginated timeline entries for an existing actor", async () => {
      const actorId = `mw-timeline-${Date.now()}`;
      await spawnCounter(actorId, 4);

      const res = await studioFetch(`/__studio/api/actors/counter/${actorId}/timeline?limit=2`);
      expect(res.status).toBe(200);
      const page1 = await res.json<{ entries: Array<{ id: number }>; hasMore: boolean }>();
      expect(page1.entries.length).toBe(2);
      expect(page1.hasMore).toBe(true);

      const before = page1.entries[1]?.id;
      const res2 = await studioFetch(`/__studio/api/actors/counter/${actorId}/timeline?limit=10&before=${before}`);
      expect(res2.status).toBe(200);
      const page2 = await res2.json<{ entries: Array<{ id: number }>; hasMore: boolean }>();
      expect(page2.hasMore).toBe(false);
      expect(page2.entries.every((e) => before !== undefined && e.id < before)).toBe(true);
    });

    it("unknown actor id is 404 and creates no phantom actor", async () => {
      const actorId = `mw-phantom-tl-${Date.now()}`;
      const res = await studioFetch(`/__studio/api/actors/counter/${actorId}/timeline`);
      expect(res.status).toBe(404);
      await new Promise((r) => setTimeout(r, 100));
      expect(await counterHasStorage(actorId)).toBe(false);
    });

    it.each([
      ["limit=abc"],
      ["limit=-1"],
      ["limit=0"],
      ["limit=1.5"],
      ["limit="],
      ["limit=100000"],
      ["before=abc"],
      ["before=-5"],
    ])("rejects invalid query %s with 400", async (query) => {
      const actorId = `mw-tl-bad-${Date.now()}`;
      await spawnCounter(actorId);
      const res = await studioFetch(`/__studio/api/actors/counter/${actorId}/timeline?${query}`);
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(typeof body.error).toBe("string");
    });
  });

  describe("list routes", () => {
    it("lists registered actors filtered by type", async () => {
      const actorId = `mw-list-${Date.now()}`;
      await spawnCounter(actorId);

      const res = await studioFetch(`/__studio/api/actors?type=counter&search=${actorId}`);
      expect(res.status).toBe(200);
      const body = await res.json<{ actors: Array<{ actorId: string; actorType: string }> }>();
      expect(body.actors.some((a) => a.actorId === actorId && a.actorType === "counter")).toBe(true);
    });

    it("lists actor types", async () => {
      await spawnCounter(`mw-types-${Date.now()}`);
      const res = await studioFetch("/__studio/api/actors/types");
      expect(res.status).toBe(200);
      const body = await res.json<{ types: string[] }>();
      expect(body.types).toContain("counter");
    });

    it.each([
      ["limit=abc"],
      ["limit=-1"],
      ["limit=0"],
      ["limit="],
      ["limit=100000"],
      ["offset=abc"],
      ["offset=-1"],
      ["offset=2.5"],
      ["type="],
      [`search=${"x".repeat(60000)}`],
    ])("rejects invalid query %s with 400", async (query) => {
      const res = await studioFetch(`/__studio/api/actors?${query}`);
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(typeof body.error).toBe("string");
    });
  });

  describe("studio WebSocket route", () => {
    it("upgrades for an existing actor and delivers a studio.snapshot", async () => {
      const actorId = `mw-ws-${Date.now()}`;
      await spawnCounter(actorId, 5);

      const res = await studioFetch(`/__studio/actors/counter/${actorId}/ws`, {
        headers: { Upgrade: "websocket" },
      });
      expect(res.status).toBe(101);
      const ws = res.webSocket;
      if (!ws) throw new Error("no webSocket on 101 response");
      ws.accept();
      const msg = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 2000);
        ws.addEventListener(
          "message",
          (e) => {
            clearTimeout(timer);
            resolve(typeof e.data === "string" ? e.data : "");
          },
          { once: true },
        );
      });
      const snapshot = z.object({ type: z.string(), state: z.object({ count: z.number() }) }).parse(JSON.parse(msg));
      expect(snapshot.type).toBe("studio.snapshot");
      expect(snapshot.state.count).toBe(5);
      ws.close(1000, "done");
      await new Promise((r) => setTimeout(r, 50));
    });

    it("refuses to upgrade for an unknown actor and creates no phantom actor", async () => {
      const actorId = `mw-ws-phantom-${Date.now()}`;
      const res = await studioFetch(`/__studio/actors/counter/${actorId}/ws`, {
        headers: { Upgrade: "websocket" },
      });
      expect(res.status).toBe(404);
      await new Promise((r) => setTimeout(r, 100));
      expect(await counterHasStorage(actorId)).toBe(false);
    });

    it("without an Upgrade header is 426", async () => {
      const actorId = `mw-ws-noupgrade-${Date.now()}`;
      await spawnCounter(actorId);
      const res = await studioFetch(`/__studio/actors/counter/${actorId}/ws`);
      expect(res.status).toBe(426);
    });
  });

  describe("production auth (secret configured, non-localhost host)", () => {
    const SECRET = "integration-test-studio-key";

    it("missing key is 401 and leaks no actor data", async () => {
      const actorId = `mw-auth-${Date.now()}`;
      await spawnCounter(actorId, 1);
      const res = await studioFetch(`/__studio/api/actors/counter/${actorId}`, {
        host: "studio.example.com",
        extraEnv: { ACTOR_KIT_STUDIO_SECRET: SECRET },
      });
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).not.toContain("count");
    });

    it("missing key on the WebSocket route is 401", async () => {
      const actorId = `mw-auth-ws-${Date.now()}`;
      await spawnCounter(actorId);
      const res = await studioFetch(`/__studio/actors/counter/${actorId}/ws`, {
        host: "studio.example.com",
        headers: { Upgrade: "websocket" },
        extraEnv: { ACTOR_KIT_STUDIO_SECRET: SECRET },
      });
      expect(res.status).toBe(401);
    });

    it("correct key returns actor data", async () => {
      const actorId = `mw-auth-ok-${Date.now()}`;
      await spawnCounter(actorId, 1);
      const res = await studioFetch(`/__studio/api/actors/counter/${actorId}`, {
        host: "studio.example.com",
        headers: { [STUDIO_KEY_HEADER]: SECRET },
        extraEnv: { ACTOR_KIT_STUDIO_SECRET: SECRET },
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ state: { count: number } }>();
      expect(body.state.count).toBe(1);
    });

    it("no secret configured on a public host is 403 even with dev-looking headers", async () => {
      const res = await studioFetch("/__studio/api/actors?dev=1", {
        host: "studio.example.com",
        headers: {
          Host: "localhost",
          "X-Forwarded-Host": "localhost",
          "X-Forwarded-For": "127.0.0.1",
          Origin: "http://localhost",
        },
      });
      expect(res.status).toBe(403);
    });
  });
});
