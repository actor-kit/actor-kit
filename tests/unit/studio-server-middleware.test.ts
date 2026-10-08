/**
 * Studio middleware seams: routing, actor resolution, registry checks, error bodies and the
 * audit wide-event, driven through createActorKitStudio() with fake DO namespaces.
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createActorKitStudio, type StudioAuditEvent } from "../../packages/studio/src/middleware";

const ctx = { waitUntil: (_p: Promise<unknown>): void => {}, passThroughOnException: (): void => {} };
const HEX = "0123456789abcdef".repeat(4);

type Fn = (...args: unknown[]) => unknown;

/** Fake DO namespace: records how ids were derived and every RPC call. */
function fakeNamespace(methods: Record<string, Fn>, opts: { idFromString?: (hex: string) => unknown } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const ids: string[] = [];
  const ns = {
    idFromName: (name: string) => {
      ids.push(`name:${name}`);
      return { toString: () => `name:${name}` };
    },
    idFromString:
      opts.idFromString ??
      ((hex: string) => {
        ids.push(`hex:${hex}`);
        return { toString: () => hex };
      }),
    get: (_id: unknown) => {
      const stub: Record<string, unknown> = {};
      for (const [name, fn] of Object.entries(methods)) {
        stub[name] = async (...args: unknown[]) => {
          calls.push({ method: name, args });
          return fn(...args);
        };
      }
      return stub;
    },
  };
  return { ns, calls, ids };
}

function studio() {
  const events: StudioAuditEvent[] = [];
  const handler = createActorKitStudio({ log: (e) => events.push(e) });
  async function call(
    path: string,
    env: Record<string, unknown> = {},
    init: { method?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const result = handler(new Request(`http://localhost/__studio${path}`, init), env, ctx);
    if (result === null) throw new Error(`passed through: ${path}`);
    return await result;
  }
  return { call, events };
}

function actorEnv(counterMethods: Record<string, Fn> = {}, hasActor: Fn = () => true) {
  const registry = fakeNamespace({ hasActor, listActors: () => [{ actorId: "a" }], getActorTypes: () => ["counter"] });
  const counter = fakeNamespace({
    __inspect: () => ({ state: { n: 1 } }),
    __getTimeline: () => ({ entries: [] }),
    __getView: () => ({ data: 1 }),
    fetch: () => new Response("upgraded"),
    ...counterMethods,
  });
  return { env: { STUDIO_REGISTRY: registry.ns, COUNTER: counter.ns }, registry, counter };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Routing ---

describe("API routing", () => {
  it("/api/actors/ (trailing slash) lists actors", async () => {
    const { env, registry } = actorEnv();
    const res = await studio().call("/api/actors/", env);
    expect(await res.json()).toEqual({ actors: [{ actorId: "a" }] });
    expect(registry.calls.map((c) => c.method)).toEqual(["listActors"]);
  });

  it("/api/actors/types lists types from the registry", async () => {
    const { env } = actorEnv();
    const res = await studio().call("/api/actors/types", env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ types: ["counter"] });
  });

  it.each([
    "/api/actors/counter/abc/timeline/extra",
    "/api/actors/counter/abc/view/extra",
    "/api/actors/counter/abc/def/ghi",
  ])("%s is an unknown API route even with the binding present", async (path) => {
    const { env, counter, registry } = actorEnv();
    const res = await studio().call(path, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Unknown studio API route: ${path}` });
    expect(counter.calls).toEqual([]);
    expect(registry.calls).toEqual([]);
  });

  it("dispatches timeline, view and inspect for multi-character ids", async () => {
    const { env, counter } = actorEnv();
    const s = studio();
    expect((await s.call("/api/actors/counter/room/timeline", env)).status).toBe(200);
    expect((await s.call("/api/actors/counter/room/view?role=viewer", env)).status).toBe(200);
    expect((await s.call("/api/actors/counter/room", env)).status).toBe(200);
    expect(counter.calls.map((c) => c.method)).toEqual(["__getTimeline", "__getView", "__inspect"]);
  });

  it.each(["/actors/counter/abc/ws/extra", "/x/actors/counter/abc/ws", "/x/api/actors/counter/abc"])(
    "%s is not a studio API or WebSocket route: it serves the SPA shell",
    async (path) => {
      const { env, counter } = actorEnv();
      const res = await studio().call(path, env, { headers: { Upgrade: "websocket" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/html");
      expect(counter.calls).toEqual([]);
    },
  );

  it("an unknown asset is a JSON 'Not found'", async () => {
    const res = await studio().call("/assets/missing.js");
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it.each(["", "/"])("the studio root %j serves the SPA shell", async (path) => {
    const res = await studio().call(path);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(await res.text()).toContain("Actor Kit Studio");
  });

  it("405 names the method", async () => {
    const res = await studio().call("/api/actors", {}, { method: "POST" });
    expect(await res.json()).toEqual({ error: "Method POST not allowed" });
  });
});

// --- Registry ---

describe("registry binding", () => {
  it("is looked up under the fixed name 'registry'", async () => {
    const { env, registry } = actorEnv();
    await studio().call("/api/actors", env);
    expect(registry.ids).toEqual(["name:registry"]);
  });

  it("without a registry, list and types are 503 with an empty payload", async () => {
    const s = studio();
    const list = await s.call("/api/actors");
    expect(list.status).toBe(503);
    expect(await list.json()).toEqual({ actors: [], error: "StudioRegistry not found in env bindings" });
    const types = await s.call("/api/actors/types");
    expect(types.status).toBe(503);
    expect(await types.json()).toEqual({ types: [], error: "StudioRegistry not found in env bindings" });
  });

  it.each([
    ["missing idFromName", { idFromString: () => ({}), get: () => ({}) }],
    ["missing idFromString", { idFromName: () => ({}), get: () => ({}) }],
    ["missing get", { idFromName: () => ({}), idFromString: () => ({}) }],
    ["a string", "registry"],
    ["null", null],
  ])("a registry binding %s is treated as absent", async (_label, binding) => {
    const res = await studio().call("/api/actors", { STUDIO_REGISTRY: binding });
    expect(res.status).toBe(503);
  });

  it("a registry stub without the RPC method is a JSON 500 naming it", async () => {
    const registry = fakeNamespace({});
    const res = await studio().call("/api/actors", { STUDIO_REGISTRY: registry.ns });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'RPC method "listActors" not found on stub' });
  });

  it("a non-Error RPC failure is a JSON 500 'Unknown error'", async () => {
    const registry = fakeNamespace({
      getActorTypes: () => {
        throw "nope";
      },
    });
    const res = await studio().call("/api/actors/types", { STUDIO_REGISTRY: registry.ns });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Unknown error" });
  });
});

// --- Query and path parsing messages ---

describe("parse errors", () => {
  it("names every invalid query parameter", async () => {
    const res = await studio().call("/api/actors?limit=abc&offset=-1", actorEnv().env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid query parameter limit: must be a non-negative integer; offset: must be a non-negative integer",
    });
  });

  it("malformed encoding in only the id says so", async () => {
    const res = await studio().call("/api/actors/counter/%E0%A4%A", actorEnv().env);
    expect(await res.json()).toEqual({ error: "Malformed percent-encoding in actor type or id" });
  });

  it("malformed encoding in only the type says so", async () => {
    const res = await studio().call("/api/actors/%E0%A4%A/abc", actorEnv().env);
    expect(await res.json()).toEqual({ error: "Malformed percent-encoding in actor type or id" });
  });

  it("an over-long actor type is a 400 naming the field, before any DO is contacted", async () => {
    const { env, registry } = actorEnv();
    const res = await studio().call(`/api/actors/${"t".repeat(129)}/abc`, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/^Invalid actor path: actorType: /) });
    expect(registry.calls).toEqual([]);
  });

  it.each(["/timeline", "/view?role=r"])("malformed encoding on %s is 400", async (suffix) => {
    const { env, counter } = actorEnv();
    const res = await studio().call(`/api/actors/counter/%E0%A4%A${suffix}`, env);
    expect(res.status).toBe(400);
    expect(counter.calls).toEqual([]);
  });

  it("the view route requires a role", async () => {
    const { env, counter } = actorEnv();
    const res = await studio().call("/api/actors/counter/abc/view", env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining("Invalid query parameter role:") });
    expect(counter.calls).toEqual([]);
  });

  it("passes role and caller to __getView", async () => {
    const { env, counter } = actorEnv();
    await studio().call("/api/actors/counter/abc/view?role=player&caller=u1", env);
    expect(counter.calls).toEqual([{ method: "__getView", args: [{ role: "player", caller: "u1" }] }]);
  });
});

// --- Actor resolution ---

describe("actor resolution", () => {
  it("maps a dashed type to its underscored binding", async () => {
    const registry = fakeNamespace({ hasActor: () => true });
    const chat = fakeNamespace({ __inspect: () => ({ ok: true }) });
    const res = await studio().call("/api/actors/chat-room/abc", { STUDIO_REGISTRY: registry.ns, CHAT_ROOM: chat.ns });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it.each(["studio-registry", "studio_registry"])("never treats the registry (%s) as an actor type", async (type) => {
    const { env, registry } = actorEnv();
    const res = await studio().call(`/api/actors/${type}/registry`, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Actor type "${type}" not found in env bindings` });
    expect(registry.calls).toEqual([]);
  });

  it("a view for an unknown type is 404", async () => {
    const res = await studio().call("/api/actors/nope/abc/view?role=r", actorEnv().env);
    expect(res.status).toBe(404);
  });

  it.each([
    [HEX, `hex:${HEX}`],
    [HEX.toUpperCase(), `hex:${HEX.toUpperCase()}`],
    [`${HEX}a`, `name:${HEX}a`],
    [`z${HEX.slice(1)}`, `name:z${HEX.slice(1)}`],
    [`zz${HEX}`, `name:zz${HEX}`],
    [`${HEX}zz`, `name:${HEX}zz`],
    ["a", "name:a"],
  ])("id %s resolves via %s", async (id, expected) => {
    const { env, counter } = actorEnv();
    const counterIds = counter.ids;
    await studio().call(`/api/actors/counter/${id}`, env);
    expect(counterIds).toEqual([expected]);
  });

  it("a 64-hex id the namespace rejects is a 404 and contacts nothing", async () => {
    const registry = fakeNamespace({ hasActor: () => true });
    const counter = fakeNamespace(
      { __inspect: () => ({}) },
      {
        idFromString: () => {
          throw new TypeError("Invalid Durable Object ID");
        },
      },
    );
    const res = await studio().call(`/api/actors/counter/${HEX}`, {
      STUDIO_REGISTRY: registry.ns,
      COUNTER: counter.ns,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Actor "counter/${HEX}" not found` });
    expect(registry.calls).toEqual([]);
    expect(counter.calls).toEqual([]);
  });

  it("without a registry the actor is contacted directly", async () => {
    const counter = fakeNamespace({ __inspect: () => ({ state: 1 }) });
    const res = await studio().call("/api/actors/counter/abc", { COUNTER: counter.ns });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 1 });
  });

  it("a hex id is checked against the registry once", async () => {
    const { env, registry } = actorEnv({}, () => false);
    const res = await studio().call(`/api/actors/counter/${HEX}`, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `Actor "counter/${HEX}" not found` });
    expect(registry.calls).toEqual([{ method: "hasActor", args: ["counter", HEX] }]);
  });

  it("only a literal true from the registry counts as existing", async () => {
    const { env, counter } = actorEnv({}, () => "yes");
    const res = await studio().call("/api/actors/counter/abc", env);
    expect(res.status).toBe(404);
    expect(counter.calls).toEqual([]);
  });

  it("a registry failure during the existence check is a JSON 500 and the actor is not contacted", async () => {
    const { env, counter } = actorEnv({}, () => {
      throw new Error("registry down");
    });
    const res = await studio().call("/api/actors/counter/abc", env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "registry down" });
    expect(counter.calls).toEqual([]);
  });

  it("a non-Error registry failure is a JSON 500 'Unknown error'", async () => {
    const { env } = actorEnv({}, () => {
      throw 42;
    });
    const res = await studio().call("/api/actors/counter/abc", env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Unknown error" });
  });
});

// --- WebSocket forwarding ---

describe("WebSocket forwarding", () => {
  it("stamps the studio identity and the human viewer", async () => {
    const seen: Request[] = [];
    const { env } = actorEnv({
      fetch: (req) => {
        if (req instanceof Request) seen.push(req);
        return new Response("upgraded");
      },
    });
    const res = await studio().call("/actors/counter/abc/ws", env, {
      headers: { Upgrade: "websocket", "X-Actor-Kit-Studio-Viewer": "agent" },
    });
    expect(res.status).toBe(200);
    const headers = seen[0]?.headers;
    expect(headers?.get("X-Actor-Kit-Caller-Id")).toBe("__studio");
    expect(headers?.get("X-Actor-Kit-Caller-Type")).toBe("service");
    expect(headers?.get("X-Actor-Kit-Studio-Viewer")).toBe("human");
  });
});

// --- Audit ---

describe("audit event", () => {
  it.each([
    ["/", "ui", {}],
    ["/assets/x.js", "ui", {}],
    ["/apix", "ui", {}],
    ["/api", "unknown", {}],
    ["/api/nope", "unknown", {}],
    ["/api/actors", "list", {}],
    ["/api/actors/", "list", {}],
    ["/api/actors/types", "types", {}],
    ["/api/actors/counter/room", "inspect", { actorType: "counter", actorId: "room" }],
    ["/api/actors/counter/room/timeline", "timeline", { actorType: "counter", actorId: "room" }],
    ["/api/actors/counter/room/view", "view", { actorType: "counter", actorId: "room" }],
    ["/actors/counter/room/ws", "ws", { actorType: "counter", actorId: "room" }],
    ["/api/actors/counter/room/timeline/x", "unknown", {}],
    ["/api/actors/counter/room/view/x", "unknown", {}],
    ["/api/actors/a/b/c/d", "unknown", {}],
    ["/actors/counter/room/ws/x", "ui", {}],
    ["/x/actors/counter/room/ws", "ui", {}],
    ["/x/api/actors/counter/room/timeline", "ui", {}],
    ["/x/api/actors/counter/room/view", "ui", {}],
    ["/x/api/actors/counter/room", "ui", {}],
    ["/api/actors/chat%20room/a%2Fb", "inspect", { actorType: "chat room", actorId: "a/b" }],
    ["/api/actors/%E0%A4%A/room", "inspect", { actorId: "room" }],
    ["/api/actors/counter/%E0%A4%A", "inspect", { actorType: "counter" }],
  ])("%s is classified as %s", async (path, route, actor) => {
    const s = studio();
    await s.call(path);
    expect(s.events).toHaveLength(1);
    const event = s.events[0];
    expect(event?.route).toBe(route);
    expect({ actorType: event?.actorType, actorId: event?.actorId }).toEqual({
      actorType: undefined,
      actorId: undefined,
      ...actor,
    });
    expect(event !== undefined && "actorType" in event).toBe("actorType" in actor);
  });

  it("truncates logged actor type and id", async () => {
    const s = studio();
    await s.call(`/api/actors/${"t".repeat(200)}/${"i".repeat(600)}`);
    expect(s.events[0]?.actorType).toBe("t".repeat(128));
    expect(s.events[0]?.actorId).toBe("i".repeat(512));
  });

  it("records a dev request with status, method, outcome and a small duration", async () => {
    const s = studio();
    await s.call("/api/actors", actorEnv().env);
    expect(s.events).toEqual([
      {
        event: "studio.request",
        principal: "dev",
        subject: "dev",
        method: "GET",
        route: "list",
        status: 200,
        durationMs: expect.any(Number),
        outcome: "ok",
      },
    ]);
    const duration = s.events[0]?.durationMs ?? -1;
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(60_000);
  });

  it.each([
    [399, "ok"],
    [400, "rejected"],
    [401, "denied"],
    [403, "denied"],
    [404, "rejected"],
    [499, "rejected"],
    [500, "error"],
    [503, "error"],
  ])("status %i is outcome %s", async (status, outcome) => {
    const registry = fakeNamespace({ hasActor: () => true });
    const counter = fakeNamespace({ fetch: () => new Response(null, { status }) });
    const s = studio();
    await s.call(
      "/actors/counter/abc/ws",
      { STUDIO_REGISTRY: registry.ns, COUNTER: counter.ns },
      { headers: { Upgrade: "websocket" } },
    );
    expect(s.events[0]?.status).toBe(status);
    expect(s.events[0]?.outcome).toBe(outcome);
  });

  it("an anonymous (denied) request has no subject", async () => {
    const events: StudioAuditEvent[] = [];
    const handler = createActorKitStudio({ log: (e) => events.push(e) });
    const result = handler(new Request("https://example.com/__studio/api/actors"), {}, ctx);
    await result;
    expect(events).toEqual([
      expect.objectContaining({ principal: "anonymous", status: 403, outcome: "denied", route: "list" }),
    ]);
    expect(events[0] !== undefined && "subject" in events[0]).toBe(false);
  });

  it("defaults to one JSON line on console.log", async () => {
    const lines: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(line);
    });
    const handler = createActorKitStudio();
    await handler(new Request("http://localhost/__studio/api/actors/types"), {}, ctx);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(typeof line).toBe("string");
    expect(JSON.parse(String(line))).toMatchObject({ event: "studio.request", route: "types", status: 503 });
  });
});

// --- Agents ---

describe("agent principals", () => {
  const TEAM = "mumm.cloudflareaccess.com";
  const AUD = "studio-aud";
  let agentToken = "";
  let jwks: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] });
    agentToken = await new SignJWT({ sub: "", common_name: "sre-agent.access" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(pair.privateKey);
  });

  async function agentCall(path: string, extraEnv: Record<string, unknown>) {
    const handler = createActorKitStudio({ access: { keysFor: () => jwks }, log: () => {} });
    const env = { STUDIO_ACCESS_TEAM_DOMAIN: TEAM, STUDIO_ACCESS_AUD: AUD, ...extraEnv };
    const result = handler(
      new Request(`https://studio.example.com/__studio${path}`, { headers: { "Cf-Access-Jwt-Assertion": agentToken } }),
      env,
      ctx,
    );
    if (result === null) throw new Error("passed through");
    return await result;
  }

  it.each([
    ["missing", {}],
    ["empty", { STUDIO_CALLER_HASH_KEY: "" }],
    ["not a string", { STUDIO_CALLER_HASH_KEY: 1 }],
  ])("are refused with 503 when the caller hash key is %s", async (_label, keyEnv) => {
    const { env, counter } = actorEnv();
    const res = await agentCall("/api/actors/counter/abc", { ...env, ...keyEnv });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Studio is not configured for agents: set STUDIO_CALLER_HASH_KEY" });
    expect(counter.calls).toEqual([]);
  });

  it("are served when the caller hash key is set", async () => {
    const { env, counter } = actorEnv();
    const res = await agentCall("/api/actors/counter/abc", { ...env, STUDIO_CALLER_HASH_KEY: "k" });
    expect(res.status).toBe(200);
    expect(counter.calls).toEqual([{ method: "__inspect", args: [{ viewer: "agent" }] }]);
  });
});
