/**
 * Auth helpers — JWT creation and validation for actor access.
 *
 * Self-contained: no imports from runtime (no cloudflare:workers).
 * Uses jose library for JWT signing/verification.
 *
 * JWT claims:
 *   sub = callerId (caller identity)
 *   act = callerType ("user" | "service")
 *   jti = actorId (ties token to specific actor)
 *   aud = actorType (prevents cross-type reuse)
 *   exp = expiry
 */

import { jwtVerify, SignJWT } from "jose";

// --- Types ---

interface CreateTokenParams {
  actorType: string;
  actorId: string;
  callerId: string;
  callerType: "user" | "service";
  secret: string;
  expiresIn?: string;
}

interface CallerInfo {
  caller: string;
  callerType: "user" | "service";
}

// --- Create access token ---

export async function createAccessToken(params: CreateTokenParams): Promise<string> {
  const { actorType, actorId, callerId, callerType, secret, expiresIn = "30d" } = params;

  const secretKey = new TextEncoder().encode(secret);

  return new SignJWT({
    act: callerType,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(callerId)
    .setJti(actorId)
    .setAudience(actorType)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey);
}

// --- Validate token and extract caller ---

export async function getCallerFromToken(
  token: string,
  actorType: string,
  actorId: string,
  secret: string,
): Promise<CallerInfo> {
  const secretKey = new TextEncoder().encode(secret);

  const { payload } = await jwtVerify(token, secretKey, {
    audience: actorType,
  });

  // Validate actor ID
  if (payload.jti !== actorId) {
    throw new Error(`Token actor ID mismatch: expected "${actorId}", got "${payload.jti}"`);
  }

  // Extract caller identity
  const caller = payload.sub;
  if (typeof caller !== "string") {
    throw new Error("Token missing subject (caller identity)");
  }

  // Extract caller type
  const callerType = payload["act"];
  if (callerType !== "user" && callerType !== "service") {
    throw new Error(`Invalid callerType in token: "${String(callerType)}"`);
  }

  return { caller, callerType };
}
