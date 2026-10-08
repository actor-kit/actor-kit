/**
 * Studio actions (ADR-014 mutate scope, ADR-015): POST /__studio/api/actors/:type/:id/actions
 * with a JSON body naming the action. Only principals with the `mutate` scope (dev on localhost,
 * admin people) may call it; agents and other people get 403 before the actor is contacted.
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createActorKitStudio, type StudioAuditEvent } from "../../packages/studio/src/middleware";

const TEAM = "mumm.cloudflareaccess.com";
const AUD = "studio-aud";
// Test-only caller-hash key, not a real secret.
const ACCESS_ENV = {
  STUDIO_ACCESS_TEAM_DOMAIN: TEAM,
  STUDIO_ACCESS_AUD: AUD,
  STUDIO_CALLER_HASH_KEY: "k",
  STUDIO_ADMIN_EMAILS: "admin@example.com",
};
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

const adminJwt = () => jwt({ sub: "a1", email: "admin@example.com" });
const userJwt = () => jwt({ sub: "u1", email: "reader@example.com" });
const agentJwt = () => jwt({ sub: "", common_name: "sre-agent.access" });

function setup(opts: { exists?: boolean; redrive?: () => unknown; fireTimer?: () => unknown; access?: boolean } = {}) {
  const events: StudioAuditEvent[] = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const stubMethods: Record<string, (...args: unknown[]) => unknown> = {
    __redrive: opts.redrive ?? (() => ({ ok: true })),
    __fireTimer: opts.fireTimer ?? (() => ({ ok: true })),
    __restore: () => ({ ok: true }),
  };
  const ns = (methods: Record<string, (...args: unknown[]) => unknown>) => ({
    idFromName: (name: string) => ({ toString: () => `name:${name}` }),
    idFromString: (hex: string) => ({ toString: () => hex }),
    get: () => {
      const stub: Record<string, unknown> = {};
      for (const [name, fn] of Object.entries(methods)) {
        stub[name] = async (...args: unknown[]) => {
          calls.push({ method: name, args });
          return fn(...args);
        };
      }
      return stub;
    },
  });
  const env = {
    STUDIO_REGISTRY: ns({ hasActor: () => opts.exists ?? true }),
    COUNTER: ns(stubMethods),
    ...(opts.access === false ? {} : ACCESS_ENV),
  };
  const studio = createActorKitStudio({ access: { keysFor: () => jwks }, log: (e) => events.push(e) });
  async function post(path: string, body: unknown, headers: Record<string, string> = {}, host = "studio.example.com") {
    const result = studio(
      new Request(`https://${host}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      env,
      ctx,
    );
    if (result === null) throw new Error("passed through");
    return await result;
  }
  const actorCalls = () => calls.filter((c) => c.method !== "hasActor");
  return { events, post, actorCalls };
}

const PATH = "/__studio/api/actors/counter/a/actions";

describe("studio actions: redrive", () => {
  it("an admin redrives a dead letter through the actor's __redrive RPC", async () => {
    const { post, actorCalls } = setup();
    const res = await post(
      PATH,
      { action: "redrive", effectId: "4:0" },
      { "Cf-Access-Jwt-Assertion": await adminJwt() },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(actorCalls()).toEqual([{ method: "__redrive", args: [{ effectId: "4:0" }] }]);
  });

  it("dev on localhost (Access not configured) has the mutate scope", async () => {
    const { post, actorCalls } = setup({ access: false });
    const res = await post(PATH, { action: "redrive", effectId: "4:0" }, {}, "localhost");
    expect(res.status).toBe(200);
    expect(actorCalls()).toHaveLength(1);
  });

  it("an actor's refusal is a 409 carrying its reason", async () => {
    const { post } = setup({ redrive: () => ({ ok: false, error: "Effect 4:0 is not a failed execution" }) });
    const res = await post(
      PATH,
      { action: "redrive", effectId: "4:0" },
      { "Cf-Access-Jwt-Assertion": await adminJwt() },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Effect 4:0 is not a failed execution" });
  });

  it.each([
    ["a reader", userJwt],
    ["an agent", agentJwt],
  ])("%s without the mutate scope gets 403 and the actor is never contacted", async (_who, token) => {
    const { post, actorCalls, events } = setup();
    const res = await post(PATH, { action: "redrive", effectId: "4:0" }, { "Cf-Access-Jwt-Assertion": await token() });
    expect(res.status).toBe(403);
    expect(actorCalls()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ route: "action", method: "POST", status: 403, outcome: "denied" });
  });

  it.each([
    ["not JSON", "{nope"],
    ["no action", { effectId: "4:0" }],
    ["unknown action", { action: "explode" }],
    ["no effect id", { action: "redrive" }],
    ["empty effect id", { action: "redrive", effectId: "" }],
    ["extra fields", { action: "redrive", effectId: "4:0", force: true }],
  ])("rejects a body with %s as 400", async (_what, body) => {
    const { post, actorCalls } = setup();
    const res = await post(PATH, body, { "Cf-Access-Jwt-Assertion": await adminJwt() });
    expect(res.status).toBe(400);
    expect(actorCalls()).toEqual([]);
  });

  it("is 404 for an actor the registry does not know (never creates one)", async () => {
    const { post, actorCalls } = setup({ exists: false });
    const res = await post(
      PATH,
      { action: "redrive", effectId: "4:0" },
      { "Cf-Access-Jwt-Assertion": await adminJwt() },
    );
    expect(res.status).toBe(404);
    expect(actorCalls()).toEqual([]);
  });

  it("audits the action with its actor", async () => {
    const { post, events } = setup();
    await post(PATH, { action: "redrive", effectId: "4:0" }, { "Cf-Access-Jwt-Assertion": await adminJwt() });
    expect(events.at(-1)).toMatchObject({
      event: "studio.request",
      principal: "human",
      subject: "admin@example.com",
      method: "POST",
      route: "action",
      actorType: "counter",
      actorId: "a",
      status: 200,
      outcome: "ok",
    });
  });

  it("GET on the actions route is 405 with Allow: POST", async () => {
    const studio = createActorKitStudio({ access: { keysFor: () => jwks }, log: () => {} });
    const res = await studio(new Request(`http://localhost${PATH}`), {}, ctx);
    expect(res?.status).toBe(405);
    expect(res?.headers.get("Allow")).toBe("POST");
  });
});

describe("studio actions: edge cases", () => {
  it("refuses with a reason naming the mutate scope", async () => {
    const { post } = setup();
    const res = await post(
      PATH,
      { action: "redrive", effectId: "4:0" },
      { "Cf-Access-Jwt-Assertion": await userJwt() },
    );
    expect(await res.json()).toEqual({ error: expect.stringContaining("mutate scope") });
  });

  it("says why a body is refused", async () => {
    const { post } = setup();
    const token = { "Cf-Access-Jwt-Assertion": await adminJwt() };
    expect(await (await post(PATH, "{nope", token)).json()).toEqual({ error: "Action body must be JSON" });
    expect(await (await post(PATH, { action: "explode" }, token)).json()).toEqual({
      error: expect.stringMatching(/^Invalid action: .+/),
    });
  });

  it("accepts a body of exactly 4096 characters and refuses a longer one with 413", async () => {
    const { post, actorCalls } = setup();
    const token = { "Cf-Access-Jwt-Assertion": await adminJwt() };
    const json = JSON.stringify({ action: "redrive", effectId: "4:0" });
    const exact = json + " ".repeat(4096 - json.length);
    expect((await post(PATH, exact, token)).status).toBe(200);
    const res = await post(PATH, `${exact} `, token);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Action body too large" });
    expect(actorCalls()).toHaveLength(1);
  });

  it("refuses an invalid actor path with 400 and an unknown actor type with 404", async () => {
    const { post, actorCalls } = setup();
    const token = { "Cf-Access-Jwt-Assertion": await adminJwt() };
    const body = { action: "redrive", effectId: "4:0" };
    expect((await post("/__studio/api/actors/%ZZ/abc/actions", body, token)).status).toBe(400);
    const res = await post("/__studio/api/actors/nope/abc/actions", body, token);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.stringContaining("not found in env bindings") });
    expect(actorCalls()).toEqual([]);
  });

  it("is a 500 with the message when the actor RPC throws", async () => {
    const { post } = setup({
      redrive: () => {
        throw new Error("Studio is not enabled for this actor");
      },
    });
    const res = await post(
      PATH,
      { action: "redrive", effectId: "4:0" },
      { "Cf-Access-Jwt-Assertion": await adminJwt() },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Studio is not enabled for this actor" });
  });

  it("is a 500 when the actor's reply has the wrong shape", async () => {
    const { post } = setup({ redrive: () => ({ done: true }) });
    const res = await post(
      PATH,
      { action: "redrive", effectId: "4:0" },
      { "Cf-Access-Jwt-Assertion": await adminJwt() },
    );
    expect(res.status).toBe(500);
  });

  it("works with multi-character actor types and ids", async () => {
    const { post, actorCalls } = setup();
    const res = await post(
      "/__studio/api/actors/counter/room-42/actions",
      { action: "redrive", effectId: "12:3" },
      { "Cf-Access-Jwt-Assertion": await adminJwt() },
    );
    expect(res.status).toBe(200);
    expect(actorCalls()).toEqual([{ method: "__redrive", args: [{ effectId: "12:3" }] }]);
  });

  it("only the exact actions path is an action: anything after it is not", async () => {
    const studio = createActorKitStudio({ access: { keysFor: () => jwks }, log: () => {} });
    const res = await studio(
      new Request("http://localhost/__studio/api/actors/counter/abc/actions/extra", { method: "POST", body: "{}" }),
      {},
      ctx,
    );
    expect(res?.status).toBe(405);
    expect(res?.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("GET on the actions route says which method was refused", async () => {
    const studio = createActorKitStudio({ access: { keysFor: () => jwks }, log: () => {} });
    const res = await studio(new Request(`http://localhost${PATH}`), {}, ctx);
    expect(await res?.json()).toEqual({ error: "Method GET not allowed" });
  });
});

describe("agents and the caller-hash key", () => {
  it("an empty STUDIO_CALLER_HASH_KEY refuses agents like a missing one (503 before any actor)", async () => {
    const calls: string[] = [];
    const ns = {
      idFromName: (name: string) => ({ toString: () => name }),
      idFromString: (hex: string) => ({ toString: () => hex }),
      get: () => ({
        __inspect: async () => {
          calls.push("__inspect");
          return {};
        },
      }),
    };
    const studio = createActorKitStudio({ access: { keysFor: () => jwks }, log: () => {} });
    const res = await studio(
      new Request("https://studio.example.com/__studio/api/actors/counter/a", {
        headers: { "Cf-Access-Jwt-Assertion": await agentJwt() },
      }),
      { ...ACCESS_ENV, STUDIO_CALLER_HASH_KEY: "", COUNTER: ns },
      ctx,
    );
    expect(res?.status).toBe(503);
    expect(calls).toEqual([]);
  });
});

describe("studio actions: routing", () => {
  it("an actions path under another prefix is not an action", async () => {
    const studio = createActorKitStudio({ access: { keysFor: () => jwks }, log: () => {} });
    const res = await studio(
      new Request("http://localhost/__studio/assets/api/actors/counter/abc/actions", { method: "POST", body: "{}" }),
      {},
      ctx,
    );
    expect(res?.status).toBe(405);
    expect(res?.headers.get("Allow")).toBe("GET, HEAD");
  });

  it('an actor RPC that throws a non-Error is a 500 "Unknown error"', async () => {
    const { post } = setup({
      redrive: () => {
        throw "boom";
      },
    });
    const res = await post(
      PATH,
      { action: "redrive", effectId: "4:0" },
      { "Cf-Access-Jwt-Assertion": await adminJwt() },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Unknown error" });
  });
});

describe("studio actions: fire a timer now", () => {
  it("an admin fires a pending timer by key through __fireTimer", async () => {
    const { post, actorCalls } = setup();
    const res = await post(
      PATH,
      { action: "fireTimer", key: "round-1" },
      { "Cf-Access-Jwt-Assertion": await adminJwt() },
    );
    expect(res.status).toBe(200);
    expect(actorCalls()).toEqual([{ method: "__fireTimer", args: [{ key: "round-1" }] }]);
  });

  it("an unknown key is a 409 with the actor's reason", async () => {
    const { post } = setup({ fireTimer: () => ({ ok: false, error: 'No pending timer with key "x"' }) });
    const res = await post(PATH, { action: "fireTimer", key: "x" }, { "Cf-Access-Jwt-Assertion": await adminJwt() });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No pending timer with key "x"' });
  });

  it.each([
    ["no key", { action: "fireTimer" }],
    ["empty key", { action: "fireTimer", key: "" }],
    ["a key over 256 characters", { action: "fireTimer", key: "k".repeat(257) }],
    ["extra fields", { action: "fireTimer", key: "k", effectId: "1:0" }],
  ])("rejects %s as 400", async (_what, body) => {
    const { post, actorCalls } = setup();
    expect((await post(PATH, body, { "Cf-Access-Jwt-Assertion": await adminJwt() })).status).toBe(400);
    expect(actorCalls()).toEqual([]);
  });

  it("accepts a key of exactly 256 characters", async () => {
    const { post } = setup();
    const res = await post(
      PATH,
      { action: "fireTimer", key: "k".repeat(256) },
      { "Cf-Access-Jwt-Assertion": await adminJwt() },
    );
    expect(res.status).toBe(200);
  });

  it("is refused without the mutate scope", async () => {
    const { post, actorCalls } = setup();
    const res = await post(PATH, { action: "fireTimer", key: "k" }, { "Cf-Access-Jwt-Assertion": await agentJwt() });
    expect(res.status).toBe(403);
    expect(actorCalls()).toEqual([]);
  });
});

describe("studio actions: restore", () => {
  it("an admin restores an actor to a journal seq through __restore", async () => {
    const { post, actorCalls } = setup();
    const res = await post(PATH, { action: "restore", toSeq: 12 }, { "Cf-Access-Jwt-Assertion": await adminJwt() });
    expect(res.status).toBe(200);
    expect(actorCalls()).toEqual([{ method: "__restore", args: [{ toSeq: 12 }] }]);
  });

  it.each([
    ["no seq", { action: "restore" }],
    ["seq 0", { action: "restore", toSeq: 0 }],
    ["a fractional seq", { action: "restore", toSeq: 1.5 }],
    ["a string seq", { action: "restore", toSeq: "3" }],
    ["extra fields", { action: "restore", toSeq: 3, key: "k" }],
  ])("rejects %s as 400", async (_what, body) => {
    const { post, actorCalls } = setup();
    expect((await post(PATH, body, { "Cf-Access-Jwt-Assertion": await adminJwt() })).status).toBe(400);
    expect(actorCalls()).toEqual([]);
  });

  it("is refused without the mutate scope", async () => {
    const { post, actorCalls } = setup();
    expect(
      (await post(PATH, { action: "restore", toSeq: 2 }, { "Cf-Access-Jwt-Assertion": await userJwt() })).status,
    ).toBe(403);
    expect(actorCalls()).toEqual([]);
  });
});
