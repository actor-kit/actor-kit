import { describe, expect, it } from "vitest";
import { actorKitStudio } from "../../packages/studio/src/middleware";
import { getAsset, listAssetPaths } from "../../packages/studio/src/ui-assets";

// --- Helpers ---

const ctx = { waitUntil: (_p: Promise<unknown>): void => {}, passThroughOnException: (): void => {} };

function request(path: string, init: { method?: string; host?: string; headers?: Record<string, string> } = {}) {
  return new Request(`http://${init.host ?? "localhost"}${path}`, {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
  });
}

async function handle(
  path: string,
  init: { method?: string; host?: string; headers?: Record<string, string> } = {},
  env: Record<string, unknown> = {},
): Promise<Response> {
  const result = actorKitStudio(request(path, init), env, ctx);
  if (result === null) throw new Error(`middleware passed ${path} through`);
  return await result;
}

/** Fake DO namespace whose stubs record every RPC call. */
function fakeNamespace(methods: Record<string, (...args: unknown[]) => unknown>) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const ns = {
    idFromName: (name: string) => ({ toString: () => `name:${name}` }),
    idFromString: (hex: string) => ({ toString: () => hex }),
    get: (_id: { toString(): string }) => {
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
  return { ns, calls };
}

// --- Prefix handling ---

describe("studio prefix handling", () => {
  it.each(["/", "/api/actors", "/__studiofoo", "/__studio-admin/api/actors", "/__studio.html", "/app/__studio/"])(
    "passes %s through to the app untouched",
    (path) => {
      expect(actorKitStudio(request(path), {}, ctx)).toBeNull();
    },
  );

  it("handles the bare /__studio prefix", async () => {
    const res = await handle("/__studio");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html");
  });
});

// --- Unknown routes / methods ---

describe("unknown API routes", () => {
  it.each([
    "/__studio/api",
    "/__studio/api/",
    "/__studio/api/foo",
    "/__studio/api/actors/counter/abc/timeline/extra",
    "/__studio/api/actors/counter/abc/unknown",
    "/__studio/api/actors//timeline",
  ])("%s is a JSON 404, not the SPA", async (path) => {
    const res = await handle(path);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body: unknown = await res.json();
    expect(body).toEqual({ error: expect.any(String) });
  });
});

describe("HTTP methods", () => {
  it.each([
    ["POST", "/__studio/api/actors"],
    ["DELETE", "/__studio/api/actors/counter/abc"],
    ["PUT", "/__studio/api/actors/counter/abc/timeline"],
    ["PATCH", "/__studio/"],
    ["POST", "/__studio/assets/app.js"],
  ])("%s %s is 405 with Allow: GET, HEAD", async (method, path) => {
    const res = await handle(path, { method });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("HEAD on the SPA shell is 200", async () => {
    const res = await handle("/__studio/", { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  it("unauthenticated POST in prod is 401 before the method check (no route probing)", async () => {
    const res = await handle(
      "/__studio/api/actors",
      { method: "POST", host: "example.com" },
      { ACTOR_KIT_STUDIO_SECRET: "s" },
    );
    expect(res.status).toBe(401);
  });
});

// --- Static UI assets ---

describe("static UI assets", () => {
  it("serves every embedded asset with its content type and immutable caching", async () => {
    const paths = listAssetPaths().filter((p) => p.startsWith("/assets/"));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      const res = await handle(`/__studio${p}`);
      expect(res.status).toBe(200);
      const expected = p.endsWith(".js") ? "application/javascript" : p.endsWith(".css") ? "text/css" : null;
      if (expected !== null) expect(res.headers.get("Content-Type")).toBe(expected);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    }
  });

  it("serves index.html with no-cache", async () => {
    const res = await handle("/__studio/");
    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(await res.text()).toContain("Actor Kit Studio");
  });

  it("an unknown asset is a 404, not the SPA shell", async () => {
    const res = await handle("/__studio/assets/does-not-exist.js");
    expect(res.status).toBe(404);
  });

  it("an unknown asset without an extension is a 404, not the SPA shell", async () => {
    const res = await handle("/__studio/assets/missing");
    expect(res.status).toBe(404);
  });

  it("path traversal under the prefix never escapes the embedded asset map", async () => {
    const res = await handle("/__studio/assets/..%2f..%2fwrangler.toml");
    expect(res.status).toBe(404);
  });

  it.each([
    "/__studio/actors/counter/room.1",
    "/__studio/actors/chat-room/user@example.com",
    "/__studio/actors/counter/v1.2.3",
  ])("deep link %s (actor id with a dot) serves the SPA shell", async (path) => {
    const res = await handle(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html");
  });

  it("embeds exactly the assets index.html references (no stale build output)", () => {
    const html = getAsset("/index.html");
    if (html === null) throw new Error("index.html not embedded");
    const text = new TextDecoder().decode(html.body);
    const referenced = [...text.matchAll(/\/__studio(\/assets\/[^"']+)/g)].map((m) => m[1]).sort();
    const embedded = listAssetPaths()
      .filter((p) => p !== "/index.html")
      .sort();
    expect(embedded).toEqual(referenced);
  });
});

// --- Query parameter parsing (registry fake records what reaches the RPC) ---

describe("list query parsing", () => {
  it("passes parsed numbers and strings to listActors", async () => {
    const { ns, calls } = fakeNamespace({ listActors: () => [] });
    const res = await handle(
      "/__studio/api/actors?type=counter&search=a%25b&limit=10&offset=20",
      {},
      { STUDIO_REGISTRY: ns },
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { method: "listActors", args: [{ type: "counter", search: "a%b", limit: 10, offset: 20 }] },
    ]);
  });

  it("omits absent params", async () => {
    const { ns, calls } = fakeNamespace({ listActors: () => [] });
    await handle("/__studio/api/actors", {}, { STUDIO_REGISTRY: ns });
    expect(calls).toEqual([{ method: "listActors", args: [{}] }]);
  });

  it.each(["limit=abc", "limit=1e3", "limit=0x10", "limit=%20", "offset=NaN", "offset=Infinity", "limit=1001"])(
    "rejects %s with 400 without calling the registry",
    async (q) => {
      const { ns, calls } = fakeNamespace({ listActors: () => [] });
      const res = await handle(`/__studio/api/actors?${q}`, {}, { STUDIO_REGISTRY: ns });
      expect(res.status).toBe(400);
      expect(calls).toEqual([]);
    },
  );

  it("a registry RPC failure is a JSON 500 without a stack trace", async () => {
    const { ns } = fakeNamespace({
      listActors: () => {
        throw new Error("boom");
      },
    });
    const res = await handle("/__studio/api/actors", {}, { STUDIO_REGISTRY: ns });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "boom" });
    expect(text).not.toContain("    at ");
  });
});

// --- Auth: dev detection cannot be spoofed ---

describe("dev-mode detection", () => {
  it.each([
    [{ Host: "localhost" }],
    [{ "X-Forwarded-Host": "localhost" }],
    [{ "X-Forwarded-For": "127.0.0.1" }],
    [{ "CF-Connecting-IP": "127.0.0.1" }],
    [{ Origin: "http://localhost:8787" }],
    [{ Referer: "http://localhost:8787/__studio/" }],
  ])("public host with spoofed %o and no secret is 403", async (headers) => {
    const res = await handle("/__studio/api/actors", { host: "studio.example.com", headers });
    expect(res.status).toBe(403);
  });

  it.each(["/__studio/api/actors?dev=1", "/__studio/api/actors?host=localhost", "/__studio/?localhost"])(
    "public host with query %s and no secret is 403",
    async (path) => {
      const res = await handle(path, { host: "studio.example.com" });
      expect(res.status).toBe(403);
    },
  );

  it.each(["localhost.example.com", "127.0.0.1.nip.io", "localhost.", "evil-localhost"])(
    "look-alike hostname %s is not treated as dev",
    async (host) => {
      const res = await handle("/__studio/api/actors", { host });
      expect(res.status).toBe(403);
    },
  );

  it("localhost with a secret configured still requires the key", async () => {
    const res = await handle("/__studio/api/actors", { host: "localhost" }, { ACTOR_KIT_STUDIO_SECRET: "s" });
    expect(res.status).toBe(401);
  });

  it("an empty key header never matches a configured secret", async () => {
    const res = await handle(
      "/__studio/api/actors",
      { host: "example.com", headers: { "X-Actor-Kit-Studio-Key": "" } },
      { ACTOR_KIT_STUDIO_SECRET: "s" },
    );
    expect(res.status).toBe(401);
  });

  it("401 and 403 bodies are JSON errors", async () => {
    const r401 = await handle("/__studio/api/actors", { host: "example.com" }, { ACTOR_KIT_STUDIO_SECRET: "s" });
    expect(r401.headers.get("Content-Type")).toContain("application/json");
    expect(await r401.json()).toEqual({ error: expect.any(String) });
    const r403 = await handle("/__studio/api/actors", { host: "example.com" });
    expect(r403.headers.get("Content-Type")).toContain("application/json");
    expect(await r403.json()).toEqual({ error: expect.stringContaining("ACTOR_KIT_STUDIO_SECRET") });
  });
});

// --- Actor routes: params validated before any DO is contacted ---

describe("actor route params", () => {
  function actorEnv() {
    const registry = fakeNamespace({ hasActor: () => true });
    const counter = fakeNamespace({
      __inspect: () => ({ state: {} }),
      __getTimeline: () => ({ entries: [], hasMore: false }),
    });
    return { env: { STUDIO_REGISTRY: registry.ns, COUNTER: counter.ns }, registry, counter };
  }

  it("malformed percent-encoding in the id is 400 and contacts nothing", async () => {
    const { env, registry, counter } = actorEnv();
    const res = await handle("/__studio/api/actors/counter/%E0%A4%A", {}, env);
    expect(res.status).toBe(400);
    expect(registry.calls).toEqual([]);
    expect(counter.calls).toEqual([]);
  });

  it("malformed percent-encoding in the type is 400", async () => {
    const { env } = actorEnv();
    const res = await handle("/__studio/api/actors/%E0%A4%A/abc", {}, env);
    expect(res.status).toBe(400);
  });

  it("a non-DO env value named like the type is 404", async () => {
    const res = await handle("/__studio/api/actors/actor-kit-studio-secret/x", {}, { ACTOR_KIT_STUDIO_SECRET: "" });
    expect(res.status).toBe(404);
  });

  it("an id the registry does not know is 404 and the actor DO is never contacted", async () => {
    const registry = fakeNamespace({ hasActor: () => false });
    const counter = fakeNamespace({ __inspect: () => ({ state: {} }) });
    const res = await handle(
      "/__studio/api/actors/counter/ghost",
      {},
      { STUDIO_REGISTRY: registry.ns, COUNTER: counter.ns },
    );
    expect(res.status).toBe(404);
    expect(counter.calls).toEqual([]);
  });

  it("checks both the name and its DO hex id against the registry", async () => {
    const seen: unknown[] = [];
    const registry = fakeNamespace({
      hasActor: (type, id) => {
        seen.push([type, id]);
        return id === "name:room";
      },
    });
    const counter = fakeNamespace({ __inspect: () => ({ state: { ok: true } }) });
    const res = await handle(
      "/__studio/api/actors/counter/room",
      {},
      { STUDIO_REGISTRY: registry.ns, COUNTER: counter.ns },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      ["counter", "room"],
      ["counter", "name:room"],
    ]);
    expect(counter.calls).toEqual([{ method: "__inspect", args: [] }]);
  });

  it("passes parsed timeline params to __getTimeline", async () => {
    const { env, counter } = actorEnv();
    const res = await handle("/__studio/api/actors/counter/abc/timeline?limit=5&before=42", {}, env);
    expect(res.status).toBe(200);
    expect(counter.calls).toEqual([{ method: "__getTimeline", args: [{ limit: 5, before: 42 }] }]);
  });

  it.each(["limit=abc", "limit=0", "limit=-3", "limit=2.5", "before=x", "before=-1", "limit=1001"])(
    "timeline %s is 400 and contacts nothing",
    async (q) => {
      const { env, registry, counter } = actorEnv();
      const res = await handle(`/__studio/api/actors/counter/abc/timeline?${q}`, {}, env);
      expect(res.status).toBe(400);
      expect(registry.calls).toEqual([]);
      expect(counter.calls).toEqual([]);
    },
  );
});

describe("studio WebSocket route params", () => {
  it("missing Upgrade header is 426 and contacts nothing", async () => {
    const registry = fakeNamespace({ hasActor: () => true });
    const res = await handle(
      "/__studio/actors/counter/abc/ws",
      {},
      { STUDIO_REGISTRY: registry.ns, COUNTER: fakeNamespace({}).ns },
    );
    expect(res.status).toBe(426);
    expect(registry.calls).toEqual([]);
  });

  it("malformed id is 400", async () => {
    const res = await handle("/__studio/actors/counter/%E0%A4%A/ws", { headers: { Upgrade: "websocket" } }, {});
    expect(res.status).toBe(400);
  });

  it("unknown actor type is 404", async () => {
    const res = await handle("/__studio/actors/nope/abc/ws", { headers: { Upgrade: "websocket" } }, {});
    expect(res.status).toBe(404);
  });

  it("unknown actor id is 404 and the actor DO is never contacted", async () => {
    const registry = fakeNamespace({ hasActor: () => false });
    const counter = fakeNamespace({ fetch: () => new Response(null) });
    const res = await handle(
      "/__studio/actors/counter/ghost/ws",
      { headers: { Upgrade: "websocket" } },
      { STUDIO_REGISTRY: registry.ns, COUNTER: counter.ns },
    );
    expect(res.status).toBe(404);
    expect(counter.calls).toEqual([]);
  });

  it("forwards with the __studio identity, scrubbing spoofed identity headers", async () => {
    const registry = fakeNamespace({ hasActor: () => true });
    const counter = fakeNamespace({
      fetch: (req) => {
        if (!(req instanceof Request)) throw new Error("expected Request");
        return new Response(
          JSON.stringify({
            id: req.headers.get("X-Actor-Kit-Caller-Id"),
            type: req.headers.get("X-Actor-Kit-Caller-Type"),
          }),
        );
      },
    });
    const res = await handle(
      "/__studio/actors/counter/abc/ws",
      {
        headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": "attacker", "X-Actor-Kit-Caller-Type": "user" },
      },
      { STUDIO_REGISTRY: registry.ns, COUNTER: counter.ns },
    );
    expect(await res.json()).toEqual({ id: "__studio", type: "service" });
  });
});
