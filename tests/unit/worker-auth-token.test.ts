/**
 * @actor-kit/worker/token: createAccessToken() signs an HS256 JWT (sub = caller, act = callerType,
 * jti = actor id, aud = actor type); getCallerFromToken() verifies it and returns the caller.
 */
import { createAccessToken, getCallerFromToken } from "@actor-kit/worker/token";
import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

// A throwaway test key, generated per run: never a real signing key.
const secret = crypto.randomUUID();
const key = new TextEncoder().encode(secret);

const token = (overrides: Partial<Parameters<typeof createAccessToken>[0]> = {}) =>
  createAccessToken({ actorType: "counter", actorId: "c1", callerId: "u1", callerType: "user", secret, ...overrides });

/** A token signed with the test key carrying arbitrary claims. */
const raw = (claims: Record<string, unknown>, subject?: string) => {
  const jwt = new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setJti("c1").setAudience("counter");
  return (subject === undefined ? jwt : jwt.setSubject(subject)).setExpirationTime("1h").sign(key);
};

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected a rejection");
}

describe("createAccessToken", () => {
  it("signs the caller, caller type, actor id and actor type, expiring in 30 days by default", async () => {
    const jwt = await token({ callerType: "service" });
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "HS256" });
    const claims = decodeJwt(jwt);
    expect(claims).toMatchObject({ sub: "u1", act: "service", jti: "c1", aud: "counter" });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(30 * 24 * 60 * 60);
  });

  it("takes a custom expiry", async () => {
    const claims = decodeJwt(await token({ expiresIn: "2h" }));
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(2 * 60 * 60);
  });
});

describe("getCallerFromToken", () => {
  it("returns the caller and caller type of a valid token", async () => {
    expect(await getCallerFromToken(await token(), "counter", "c1", secret)).toEqual({
      caller: "u1",
      callerType: "user",
    });
    expect(await getCallerFromToken(await token({ callerType: "service" }), "counter", "c1", secret)).toEqual({
      caller: "u1",
      callerType: "service",
    });
  });

  it("refuses a token for another actor id", async () => {
    const error = await rejection(getCallerFromToken(await token(), "counter", "c2", secret));
    expect(error.message).toBe('Token actor ID mismatch: expected "c2", got "c1"');
  });

  it("refuses a token for another actor type, or signed with another secret", async () => {
    await rejection(getCallerFromToken(await token(), "chat", "c1", secret));
    await rejection(getCallerFromToken(await token(), "counter", "c1", `${secret}x`));
  });

  it("refuses a token without a subject", async () => {
    const error = await rejection(getCallerFromToken(await raw({ act: "user" }), "counter", "c1", secret));
    expect(error.message).toBe("Token missing subject (caller identity)");
  });

  it.each([["admin"], [undefined]])("refuses a caller type of %j", async (act) => {
    const error = await rejection(getCallerFromToken(await raw({ act }, "u1"), "counter", "c1", secret));
    expect(error.message).toBe(`Invalid callerType in token: "${String(act)}"`);
  });
});
