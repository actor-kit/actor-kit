import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AccessDeps,
  type AuthResult,
  authenticateStudio,
  hasScope,
  type StudioPrincipal,
} from "../../packages/studio/src/access";

const TEAM = "mumm.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const AUD = "studio-aud-tag";
const ACCESS_ENV = { STUDIO_ACCESS_TEAM_DOMAIN: TEAM, STUDIO_ACCESS_AUD: AUD };

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: Keys;
let otherKeys: Keys;
let deps: AccessDeps;
const requestedTeams: string[] = [];

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  otherKeys = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  deps = {
    keysFor: (team) => {
      requestedTeams.push(team);
      return jwks;
    },
  };
});

async function sign(
  claims: JWTPayload,
  opts: { key?: Keys; iss?: string; aud?: string; exp?: string | number } = {},
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign((opts.key ?? keys).privateKey);
}

const userClaims = { sub: "user-123", email: "jon@example.com", type: "app" };
const serviceClaims = { sub: "", common_name: "sre-agent.access", type: "app" };

async function auth(host: string, env: Record<string, unknown>, jwt?: string): Promise<AuthResult> {
  const headers: Record<string, string> = jwt === undefined ? {} : { "Cf-Access-Jwt-Assertion": jwt };
  const req = new Request(`https://${host}/__studio/api/actors`, { headers });
  return await authenticateStudio(req, new URL(req.url), env, deps);
}

function principal(result: AuthResult): StudioPrincipal {
  if (!result.ok) throw new Error(`expected ok, got ${result.status} ${result.error}`);
  return result.principal;
}

function denied(result: AuthResult): { status: number; error: string } {
  if (result.ok) throw new Error(`expected denial, got ${result.principal.kind}`);
  return { status: result.status, error: result.error };
}

describe("authenticateStudio: dev mode", () => {
  it.each(["localhost", "127.0.0.1"])("allows %s as the dev principal with read and mutate", async (host) => {
    const req = new Request(`http://${host}/__studio/`);
    const p = principal(await authenticateStudio(req, new URL(req.url), {}, deps));
    expect(p).toMatchObject({ kind: "dev", subject: "dev" });
    expect(hasScope(p, "read")).toBe(true);
    expect(hasScope(p, "mutate")).toBe(true);
  });

  it("refuses a remote host when Access is not configured, naming the missing settings", async () => {
    const d = denied(await auth("example.com", {}));
    expect(d.status).toBe(403);
    expect(d.error).toContain("STUDIO_ACCESS_TEAM_DOMAIN");
    expect(d.error).toContain("STUDIO_ACCESS_AUD");
  });

  it("no longer honours the removed shared key header", async () => {
    const req = new Request("https://example.com/__studio/", { headers: { "X-Actor-Kit-Studio-Key": "s" } });
    const d = denied(await authenticateStudio(req, new URL(req.url), { ACTOR_KIT_STUDIO_SECRET: "s" }, deps));
    expect(d.status).toBe(403);
  });

  it("requires a JWT on localhost once Access is configured", async () => {
    expect(denied(await auth("localhost", ACCESS_ENV)).status).toBe(401);
  });

  it.each([[{ STUDIO_ACCESS_TEAM_DOMAIN: TEAM }], [{ STUDIO_ACCESS_AUD: AUD }]])(
    "fails closed on partial Access config %#, even on localhost",
    async (env) => {
      const d = denied(await auth("localhost", env));
      expect(d.status).toBe(403);
      expect(d.error).toContain("misconfigured");
    },
  );

  it.each(["https://mumm.cloudflareaccess.com", "mumm.example.com", "mumm.cloudflareaccess.com/x", ""])(
    "rejects a malformed team domain %j",
    async (team) => {
      const d = denied(await auth("example.com", { STUDIO_ACCESS_TEAM_DOMAIN: team, STUDIO_ACCESS_AUD: AUD }));
      expect(d.status).toBe(403);
    },
  );
});

describe("authenticateStudio: Access JWT", () => {
  it("looks up signing keys for the configured team", async () => {
    await auth("studio.example.com", ACCESS_ENV, await sign(userClaims));
    expect(requestedTeams).toContain(TEAM);
  });

  it("accepts a user token as a read-only human", async () => {
    const p = principal(await auth("studio.example.com", ACCESS_ENV, await sign(userClaims)));
    expect(p).toMatchObject({ kind: "human", subject: "jon@example.com" });
    expect(hasScope(p, "read")).toBe(true);
    expect(hasScope(p, "mutate")).toBe(false);
  });

  it("grants mutate to an admin email (case- and space-insensitive)", async () => {
    const env = { ...ACCESS_ENV, STUDIO_ADMIN_EMAILS: "someone@example.com, JON@Example.com " };
    const p = principal(await auth("studio.example.com", env, await sign(userClaims)));
    expect(hasScope(p, "mutate")).toBe(true);
  });

  it("accepts a service token as a read-only agent identified by its client id", async () => {
    const p = principal(await auth("studio.example.com", ACCESS_ENV, await sign(serviceClaims)));
    expect(p).toMatchObject({ kind: "agent", subject: "sre-agent.access" });
    expect(hasScope(p, "read")).toBe(true);
    expect(hasScope(p, "mutate")).toBe(false);
  });

  it("never grants mutate to a service token, even if its client id is listed as an admin", async () => {
    const env = { ...ACCESS_ENV, STUDIO_ADMIN_EMAILS: "sre-agent.access" };
    const p = principal(await auth("studio.example.com", env, await sign(serviceClaims)));
    expect(hasScope(p, "mutate")).toBe(false);
  });

  it("rejects a missing assertion", async () => {
    const d = denied(await auth("studio.example.com", ACCESS_ENV));
    expect(d.status).toBe(401);
    expect(d.error).toContain("Cloudflare Access");
  });

  it.each([
    ["garbage", async () => "not-a-jwt"],
    ["wrong audience", async () => await sign(userClaims, { aud: "other-app" })],
    ["wrong issuer", async () => await sign(userClaims, { iss: "https://evil.cloudflareaccess.com" })],
    ["expired", async () => await sign(userClaims, { exp: Math.floor(Date.now() / 1000) - 60 })],
    ["signed by another key", async () => await sign(userClaims, { key: otherKeys })],
    ["user token without email", async () => await sign({ sub: "user-123" })],
    ["service token without common_name", async () => await sign({ sub: "" })],
    ["empty email", async () => await sign({ sub: "u", email: "" })],
  ])("rejects %s with 401", async (_name, make) => {
    expect(denied(await auth("studio.example.com", ACCESS_ENV, await make())).status).toBe(401);
  });

  it("rejects an HS256 token signed with the AUD as a secret (algorithm confusion)", async () => {
    const hs = await new SignJWT(userClaims)
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(AUD));
    expect(denied(await auth("studio.example.com", ACCESS_ENV, hs)).status).toBe(401);
  });

  it("does not leak verifier internals in the error", async () => {
    const d = denied(await auth("studio.example.com", ACCESS_ENV, await sign(userClaims, { aud: "other-app" })));
    expect(d.error).toBe("Invalid Cloudflare Access token");
  });
});
