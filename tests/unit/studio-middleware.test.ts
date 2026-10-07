import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
// Import middleware directly to avoid cloudflare:workers dependency
import { actorKitStudio, createActorKitStudio } from "../../packages/studio/src/middleware";

const ACCESS_ENV = { STUDIO_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", STUDIO_ACCESS_AUD: "aud" };

// --- Helpers ---

function makeRequest(path: string, opts?: { headers?: Record<string, string>; hostname?: string }): Request {
  const hostname = opts?.hostname ?? "localhost";
  const url = `http://${hostname}${path}`;
  const init: RequestInit = {};
  if (opts?.headers) {
    init.headers = opts.headers;
  }
  return new Request(url, init);
}

// Minimal stub for ExecutionContext — middleware doesn't use it
const fakeCtx = {} as { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };

// --- Tests ---

describe("actorKitStudio middleware", () => {
  describe("routing", () => {
    it("returns null for non-studio paths", () => {
      const result = actorKitStudio(makeRequest("/api/counter/abc"), {}, fakeCtx);
      expect(result).toBeNull();
    });

    it("handles /__studio/ path", () => {
      const result = actorKitStudio(makeRequest("/__studio/"), {}, fakeCtx);
      expect(result).not.toBeNull();
      expect(result?.status).toBe(200);
    });

    it("handles /__studio/api/actors path", () => {
      const result = actorKitStudio(makeRequest("/__studio/api/actors"), {}, fakeCtx);
      expect(result).not.toBeNull();
      // Without registry, should return 503
      expect(result?.status).toBe(503);
    });

    it("handles /__studio/api/actors/types path", () => {
      const result = actorKitStudio(makeRequest("/__studio/api/actors/types"), {}, fakeCtx);
      expect(result).not.toBeNull();
      expect(result?.status).toBe(503);
    });

    it("handles /__studio/api/actors/:type/:id path", () => {
      const result = actorKitStudio(makeRequest("/__studio/api/actors/counter/abc"), {}, fakeCtx);
      expect(result).not.toBeNull();
      // Without actor binding, should return 404
      expect(result?.status).toBe(404);
    });

    it("handles /__studio/api/actors/:type/:id/timeline path", () => {
      const result = actorKitStudio(makeRequest("/__studio/api/actors/counter/abc/timeline"), {}, fakeCtx);
      expect(result).not.toBeNull();
      expect(result?.status).toBe(404);
    });
  });

  describe("auth", () => {
    it("allows localhost without secret", () => {
      const result = actorKitStudio(makeRequest("/__studio/", { hostname: "localhost" }), {}, fakeCtx);
      expect(result?.status).not.toBe(403);
      expect(result?.status).not.toBe(401);
    });

    it("allows 127.0.0.1 without secret", () => {
      const result = actorKitStudio(makeRequest("/__studio/", { hostname: "127.0.0.1" }), {}, fakeCtx);
      expect(result?.status).not.toBe(403);
      expect(result?.status).not.toBe(401);
    });

    it("rejects non-localhost without secret", () => {
      const result = actorKitStudio(makeRequest("/__studio/", { hostname: "example.com" }), {}, fakeCtx);
      expect(result?.status).toBe(403);
    });

    // ADR-014: these two replaced "rejects with wrong secret" / "allows with correct secret"
    // when the shared X-Actor-Kit-Studio-Key header was removed in favour of Cloudflare Access.
    it("rejects an invalid Access token", async () => {
      const result = actorKitStudio(
        makeRequest("/__studio/", {
          hostname: "example.com",
          headers: { "Cf-Access-Jwt-Assertion": "wrong" },
        }),
        ACCESS_ENV,
        fakeCtx,
      );
      expect((await result)?.status).toBe(401);
    });

    it("allows a valid Access token", async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "RS256" }] });
      const token = await new SignJWT({ sub: "u", email: "jon@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: "k" })
        .setIssuer("https://team.cloudflareaccess.com")
        .setAudience("aud")
        .setExpirationTime("5m")
        .sign(privateKey);
      const studio = createActorKitStudio({ access: { keysFor: () => jwks }, log: () => {} });
      const result = studio(
        makeRequest("/__studio/", { hostname: "example.com", headers: { "Cf-Access-Jwt-Assertion": token } }),
        ACCESS_ENV,
        fakeCtx,
      );
      expect((await result)?.status).toBe(200);
    });
  });

  describe("SPA fallback", () => {
    it("serves HTML for unknown studio paths", () => {
      const result = actorKitStudio(makeRequest("/__studio/some/random/path"), {}, fakeCtx);
      expect(result?.status).toBe(200);
      expect(result?.headers.get("Content-Type")).toBe("text/html");
    });
  });
});
