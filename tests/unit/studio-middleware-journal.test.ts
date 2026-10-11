/**
 * ADR-019 F: the Studio journal route `/__studio/api/actors/:type/:id/journal`. Every query
 * parameter is parsed before anything is contacted; the parsed query reaches `__journal` with the
 * agent viewer for agents; the audit event names the route.
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createActorKitStudio, JOURNAL_CAUSE_TYPES, type StudioAuditEvent } from "../../packages/studio/src/middleware";
import { JOURNAL_CAUSE_TYPES as WORKER_CAUSE_TYPES } from "../../packages/worker/src/runtime/journal";

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

function setup(env: Record<string, unknown> = {}) {
  const events: StudioAuditEvent[] = [];
  const registry = fakeNamespace({ hasActor: () => true });
  const lot = fakeNamespace({ __journal: () => ({ entries: [], hasMore: false }) });
  const studio = createActorKitStudio({ access: { keysFor: () => jwks }, log: (e) => events.push(e) });
  async function call(path: string, headers: Record<string, string> = {}, host = "localhost") {
    const result = studio(
      new Request(`http://${host}${path}`, { headers }),
      { STUDIO_REGISTRY: registry.ns, LOT: lot.ns, ...env },
      ctx,
    );
    if (result === null) throw new Error("passed through");
    return await result;
  }
  return { events, registry, lot, call };
}

describe("Studio journal route", () => {
  it("passes every parsed parameter to __journal", async () => {
    const { call, lot } = setup();
    const res = await call(
      "/__studio/api/actors/lot/l1/journal?from=2&to=9&before=8&causeType=timer&event=Sold&correlationId=lot%2Fl1%2F3&limit=5&order=asc",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [], hasMore: false });
    expect(lot.calls).toEqual([
      {
        method: "__journal",
        args: [
          {
            from: 2,
            to: 9,
            before: 8,
            causeType: "timer",
            event: "Sold",
            correlationId: "lot/l1/3",
            limit: 5,
            order: "asc",
          },
        ],
      },
    ]);
  });

  it("accepts order=desc", async () => {
    const { call, lot } = setup();
    await call("/__studio/api/actors/lot/l1/journal?order=desc");
    expect(lot.calls).toEqual([{ method: "__journal", args: [{ order: "desc" }] }]);
  });

  it("is 400 for a malformed actor id and 404 for an actor type with no binding, contacting nothing", async () => {
    const { call, registry, lot } = setup();
    expect((await call("/__studio/api/actors/lot/%E0%A4%A/journal")).status).toBe(400);
    expect((await call("/__studio/api/actors/auction/a1/journal")).status).toBe(404);
    expect(registry.calls).toEqual([]);
    expect(lot.calls).toEqual([]);
  });

  it("passes an empty query when none is given", async () => {
    const { call, lot } = setup();
    await call("/__studio/api/actors/lot/l1/journal");
    expect(lot.calls).toEqual([{ method: "__journal", args: [{}] }]);
  });

  it.each([
    "from=x",
    "to=-1",
    "before=1.5",
    "limit=0",
    "limit=1001",
    "causeType=nope",
    "event=",
    "correlationId=",
    "order=up",
    `event=${"e".repeat(257)}`,
    `correlationId=${"c".repeat(1025)}`,
  ])("%s is 400 and contacts nothing", async (q) => {
    const { call, registry, lot } = setup();
    const res = await call(`/__studio/api/actors/lot/l1/journal?${q}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: expect.stringContaining(q.split("=")[0] ?? "") });
    expect(registry.calls).toEqual([]);
    expect(lot.calls).toEqual([]);
  });

  it("accepts the longest event and correlation id", async () => {
    const { call } = setup();
    const res = await call(
      `/__studio/api/actors/lot/l1/journal?event=${"e".repeat(256)}&correlationId=${"c".repeat(1024)}`,
    );
    expect(res.status).toBe(200);
  });

  it("agents query as the agent viewer, and the audit event names the route", async () => {
    const { call, lot, events } = setup(ACCESS_ENV);
    const token = await jwt({ sub: "", common_name: "sre-agent.access" });
    await call(
      "/__studio/api/actors/lot/l1/journal?limit=3",
      { "Cf-Access-Jwt-Assertion": token },
      "studio.example.com",
    );
    expect(lot.calls).toEqual([{ method: "__journal", args: [{ limit: 3, viewer: "agent" }] }]);
    expect(events).toMatchObject([{ route: "journal", actorType: "lot", actorId: "l1", principal: "agent" }]);
  });

  it("is 404 for an actor the registry does not know", async () => {
    const { call, lot } = setup({ STUDIO_REGISTRY: fakeNamespace({ hasActor: () => false }).ns });
    const res = await call("/__studio/api/actors/lot/l1/journal");
    expect(res.status).toBe(404);
    expect(lot.calls).toEqual([]);
  });

  it("knows the worker's cause types", () => {
    expect([...JOURNAL_CAUSE_TYPES]).toEqual([...WORKER_CAUSE_TYPES]);
  });
});
