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

function setup(opts: { exists?: boolean; redrive?: () => unknown; access?: boolean } = {}) {
  const events: StudioAuditEvent[] = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const stubMethods: Record<string, (...args: unknown[]) => unknown> = {
    __redrive: opts.redrive ?? (() => ({ ok: true })),
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
