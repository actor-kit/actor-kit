/**
 * Studio middleware behind Cloudflare Access (ADR-014): principals reach the DO as viewers,
 * every request emits one audit wide-event, and the read-only view route.
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createActorKitStudio, type StudioAuditEvent } from "../../packages/studio/src/middleware";

const TEAM = "mumm.cloudflareaccess.com";
const AUD = "studio-aud";
// Test-only caller-hash key, not a real secret.
const ACCESS_ENV = { STUDIO_ACCESS_TEAM_DOMAIN: TEAM, STUDIO_ACCESS_AUD: AUD, STUDIO_CALLER_HASH_KEY: "k" };
const ctx = { waitUntil: (_p: Promise<unknown>): void => {}, passThroughOnException: (): void => {} };

let privateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] });
});

async function jwt(claims: JWTPayload): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setExpirationTime("5m")
    .sign(privateKey);
}

const userJwt = () => jwt({ sub: "u1", email: "jon@example.com" });
const agentJwt = () => jwt({ sub: "", common_name: "sre-agent.access" });

function fakeNamespace(methods: Record<string, (...args: unknown[]) => unknown>) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const fetched: Request[] = [];
  const ns = {
    idFromName: (name: string) => ({ toString: () => `name:${name}` }),
    idFromString: (hex: string) => ({ toString: () => hex }),
    get: (_id: { toString(): string }) => {
      const stub: Record<string, unknown> = {
        fetch: async (req: Request) => {
          fetched.push(req);
          return new Response("upgraded", { status: 200 });
        },
      };
      for (const [name, fn] of Object.entries(methods)) {
        stub[name] = async (...args: unknown[]) => {
          calls.push({ method: name, args });
          return fn(...args);
        };
      }
      return stub;
    },
  };
  return { ns, calls, fetched };
}

function setup(extraEnv: Record<string, unknown> = ACCESS_ENV) {
  const events: StudioAuditEvent[] = [];
  const registry = fakeNamespace({ hasActor: () => true, listActors: () => [] });
  const counter = fakeNamespace({
    __inspect: () => ({ state: { n: 1 } }),
    __getTimeline: () => ({ entries: [], hasMore: false }),
    __getView: () => ({ role: "viewer", caller: null, callerRole: null, data: { n: 1 } }),
  });
  const studio = createActorKitStudio({ access: { keysFor: () => jwks }, log: (e) => events.push(e) });
  const env = { STUDIO_REGISTRY: registry.ns, COUNTER: counter.ns, ...extraEnv };
  async function call(path: string, headers: Record<string, string> = {}, host = "studio.example.com") {
    const result = studio(new Request(`https://${host}${path}`, { headers }), env, ctx);
    if (result === null) throw new Error("passed through");
    return await result;
  }
  return { events, counter, call };
}

describe("Access-authenticated requests", () => {
  it("serves the SPA to a signed-in person", async () => {
    const { call } = setup();
    const res = await call("/__studio/", { "Cf-Access-Jwt-Assertion": await userJwt() });
    expect(res.status).toBe(200);
  });

  it("people inspect with the default (human) viewer", async () => {
    const { call, counter } = setup();
    const res = await call("/__studio/api/actors/counter/a", { "Cf-Access-Jwt-Assertion": await userJwt() });
    expect(res.status).toBe(200);
    expect(counter.calls).toEqual([{ method: "__inspect", args: [] }]);
  });

  it("agents inspect as the agent viewer", async () => {
    const { call, counter } = setup();
    await call("/__studio/api/actors/counter/a", { "Cf-Access-Jwt-Assertion": await agentJwt() });
    expect(counter.calls).toEqual([{ method: "__inspect", args: [{ viewer: "agent" }] }]);
  });

  it("agents read the timeline as the agent viewer", async () => {
    const { call, counter } = setup();
    await call("/__studio/api/actors/counter/a/timeline?limit=3", { "Cf-Access-Jwt-Assertion": await agentJwt() });
    expect(counter.calls).toEqual([{ method: "__getTimeline", args: [{ limit: 3, viewer: "agent" }] }]);
  });

  it("stamps the viewer on the studio WebSocket and scrubs an inbound one", async () => {
    const { call, counter } = setup();
    await call("/__studio/actors/counter/a/ws", {
      Upgrade: "websocket",
      "Cf-Access-Jwt-Assertion": await agentJwt(),
      "X-Actor-Kit-Studio-Viewer": "human",
    });
    expect(counter.fetched).toHaveLength(1);
    expect(counter.fetched[0]?.headers.get("X-Actor-Kit-Studio-Viewer")).toBe("agent");
  });

  it("people get the human viewer on the WebSocket", async () => {
    const { call, counter } = setup();
    await call("/__studio/actors/counter/a/ws", { Upgrade: "websocket", "Cf-Access-Jwt-Assertion": await userJwt() });
    expect(counter.fetched[0]?.headers.get("X-Actor-Kit-Studio-Viewer")).toBe("human");
  });

  it("refuses agents with 503 when STUDIO_CALLER_HASH_KEY is unset, before contacting any DO", async () => {
    const { call, counter, events } = setup({ STUDIO_ACCESS_TEAM_DOMAIN: TEAM, STUDIO_ACCESS_AUD: AUD });
    const res = await call("/__studio/api/actors/counter/a", { "Cf-Access-Jwt-Assertion": await agentJwt() });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: expect.stringContaining("STUDIO_CALLER_HASH_KEY") });
    expect(counter.calls).toEqual([]);
    expect(events[0]).toMatchObject({ principal: "agent", status: 503, outcome: "error" });
  });

  it("people do not need STUDIO_CALLER_HASH_KEY", async () => {
    const { call } = setup({ STUDIO_ACCESS_TEAM_DOMAIN: TEAM, STUDIO_ACCESS_AUD: AUD });
    const res = await call("/__studio/api/actors/counter/a", { "Cf-Access-Jwt-Assertion": await userJwt() });
    expect(res.status).toBe(200);
  });

  it("rejects without contacting any DO when the token is invalid", async () => {
    const { call, counter } = setup();
    const res = await call("/__studio/api/actors/counter/a", { "Cf-Access-Jwt-Assertion": "nope" });
    expect(res.status).toBe(401);
    expect(counter.calls).toEqual([]);
  });
});

describe("view route", () => {
  it("passes role and caller to __getView", async () => {
    const { call, counter } = setup({});
    const res = await call("/__studio/api/actors/counter/a/view?role=player&caller=u1", {}, "localhost");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "viewer", caller: null, callerRole: null, data: { n: 1 } });
    expect(counter.calls).toEqual([{ method: "__getView", args: [{ role: "player", caller: "u1" }] }]);
  });

  it("omits caller for shared views", async () => {
    const { call, counter } = setup({});
    await call("/__studio/api/actors/counter/a/view?role=viewer", {}, "localhost");
    expect(counter.calls).toEqual([{ method: "__getView", args: [{ role: "viewer" }] }]);
  });

  it("agents ask as the agent viewer", async () => {
    const { call, counter } = setup();
    await call("/__studio/api/actors/counter/a/view?role=viewer", { "Cf-Access-Jwt-Assertion": await agentJwt() });
    expect(counter.calls).toEqual([{ method: "__getView", args: [{ role: "viewer", viewer: "agent" }] }]);
  });

  it.each(["", "?role=", `?role=${"r".repeat(129)}`, `?role=a&caller=${"c".repeat(513)}`])(
    "rejects bad query %j with 400 and contacts nothing",
    async (query) => {
      const { call, counter } = setup({});
      const res = await call(`/__studio/api/actors/counter/a/view${query}`, {}, "localhost");
      expect(res.status).toBe(400);
      expect(counter.calls).toEqual([]);
    },
  );
});

describe("audit wide-event", () => {
  it("emits exactly one event per studio request, naming the principal and the actor", async () => {
    const { call, events } = setup();
    const token = await agentJwt();
    await call("/__studio/api/actors/counter/room-7/timeline", { "Cf-Access-Jwt-Assertion": token });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "studio.request",
      principal: "agent",
      subject: "sre-agent.access",
      method: "GET",
      route: "timeline",
      actorType: "counter",
      actorId: "room-7",
      status: 200,
      outcome: "ok",
    });
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it("logs denials as anonymous", async () => {
    const { call, events } = setup();
    await call("/__studio/api/actors/counter/a");
    expect(events).toEqual([
      expect.objectContaining({ principal: "anonymous", status: 401, outcome: "denied", route: "inspect" }),
    ]);
    expect(events[0]?.subject).toBeUndefined();
  });

  it.each([
    ["/__studio/", "ui"],
    ["/__studio/api/actors", "list"],
    ["/__studio/api/actors/types", "types"],
    ["/__studio/api/actors/counter/a/view?role=r", "view"],
    ["/__studio/api/nope", "unknown"],
  ])("classifies %s as %s", async (path, route) => {
    const { call, events } = setup({});
    await call(path, {}, "localhost");
    expect(events[0]).toMatchObject({ route, principal: "dev", subject: "dev" });
  });

  it("logs the WebSocket route", async () => {
    const { call, events } = setup({});
    await call("/__studio/actors/counter/a/ws", { Upgrade: "websocket" }, "localhost");
    expect(events[0]).toMatchObject({ route: "ws", actorType: "counter", actorId: "a" });
  });

  it("marks server failures as error", async () => {
    const events: StudioAuditEvent[] = [];
    const studio = createActorKitStudio({ log: (e) => events.push(e) });
    const broken = fakeNamespace({ hasActor: () => true, listActors: () => Promise.reject(new Error("boom")) });
    const result = studio(new Request("http://localhost/__studio/api/actors"), { STUDIO_REGISTRY: broken.ns }, ctx);
    await result;
    expect(events[0]).toMatchObject({ status: 500, outcome: "error" });
  });

  it("logs nothing for requests outside /__studio", () => {
    const { events } = setup();
    const studio = createActorKitStudio({ log: (e) => events.push(e) });
    expect(studio(new Request("https://x.com/api"), {}, ctx)).toBeNull();
    expect(events).toEqual([]);
  });
});
