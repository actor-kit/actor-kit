/**
 * Studio authentication (ADR-014).
 *
 * Production: Cloudflare Access sits in front of /__studio and forwards a signed JWT in
 * `Cf-Access-Jwt-Assertion`. It is verified here (RS256, issuer, audience, expiry) against
 * the team's certs, because the Worker may also be reachable on routes Access does not cover.
 *
 * Dev: no Access config + the request hostname is exactly localhost/127.0.0.1.
 */

import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { z } from "zod";

export type Scope = "read" | "mutate";

export interface StudioPrincipal {
  /** human = SSO user, agent = Access service token, dev = localhost without Access config. */
  kind: "human" | "agent" | "dev";
  /** Email (human), service token client id (agent) or "dev". Never a secret. */
  subject: string;
  scopes: ReadonlySet<Scope>;
}

export type AuthResult = { ok: true; principal: StudioPrincipal } | { ok: false; status: 401 | 403; error: string };

export interface AccessDeps {
  /** Signing keys for an Access team domain. */
  keysFor(teamDomain: string): JWTVerifyGetKey;
}

const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** `<team>.cloudflareaccess.com` (the error shown is the deny() message below). */
const TeamDomain = z.string().regex(/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/i);

const AccessEnv = z.object({
  STUDIO_ACCESS_TEAM_DOMAIN: z.string().optional(),
  STUDIO_ACCESS_AUD: z.string().optional(),
  STUDIO_ADMIN_EMAILS: z.string().optional(),
});

/** User tokens carry a non-empty sub and email; service tokens an empty sub and the client id as common_name. */
const AccessClaims = z.union([
  z.object({ sub: z.string().min(1), email: z.string().min(1) }),
  z.object({ sub: z.literal(""), common_name: z.string().min(1) }),
]);

const READ: ReadonlySet<Scope> = new Set<Scope>(["read"]);
const READ_MUTATE: ReadonlySet<Scope> = new Set<Scope>(["read", "mutate"]);

export function hasScope(principal: StudioPrincipal, scope: Scope): boolean {
  return principal.scopes.has(scope);
}

const remoteKeys = new Map<string, JWTVerifyGetKey>();

/** Default deps: the team's published certs, cached per isolate (jose refetches on an unknown kid). */
export const remoteAccessKeys: AccessDeps = {
  keysFor(teamDomain) {
    let keys = remoteKeys.get(teamDomain);
    if (keys === undefined) {
      keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
      remoteKeys.set(teamDomain, keys);
    }
    return keys;
  },
};

function deny(status: 401 | 403, error: string): AuthResult {
  return { ok: false, status, error };
}

function isLocalHost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/**
 * Authenticate a Studio request. Synchronous when no JWT has to be verified,
 * so dev-mode and misconfiguration answers stay synchronous.
 */
export function authenticateStudio(
  request: Request,
  url: URL,
  env: Record<string, unknown>,
  deps: AccessDeps,
): AuthResult | Promise<AuthResult> {
  const parsedEnv = AccessEnv.safeParse(env);
  if (!parsedEnv.success) {
    return deny(403, "Studio is misconfigured: STUDIO_ACCESS_* settings must be strings");
  }
  const team = emptyToUndefined(parsedEnv.data.STUDIO_ACCESS_TEAM_DOMAIN);
  const aud = emptyToUndefined(parsedEnv.data.STUDIO_ACCESS_AUD);

  if (team === undefined && aud === undefined) {
    if (isLocalHost(url)) return { ok: true, principal: { kind: "dev", subject: "dev", scopes: READ_MUTATE } };
    return deny(
      403,
      "Studio is not configured. Put /__studio behind Cloudflare Access and set STUDIO_ACCESS_TEAM_DOMAIN and STUDIO_ACCESS_AUD.",
    );
  }
  if (team === undefined || aud === undefined) {
    return deny(403, "Studio is misconfigured: set both STUDIO_ACCESS_TEAM_DOMAIN and STUDIO_ACCESS_AUD");
  }
  const teamDomain = TeamDomain.safeParse(team);
  if (!teamDomain.success) {
    return deny(403, "Studio is misconfigured: STUDIO_ACCESS_TEAM_DOMAIN must be <team>.cloudflareaccess.com");
  }

  const assertion = request.headers.get(ACCESS_JWT_HEADER);
  if (assertion === null || assertion === "") {
    return deny(401, "Sign in through Cloudflare Access to use Studio");
  }

  const admins = parseAdmins(parsedEnv.data.STUDIO_ADMIN_EMAILS);
  return verify(assertion, teamDomain.data, aud, admins, deps);
}

function parseAdmins(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined) return new Set();
  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== ""),
  );
}

async function verify(
  assertion: string,
  teamDomain: string,
  aud: string,
  admins: ReadonlySet<string>,
  deps: AccessDeps,
): Promise<AuthResult> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(assertion, deps.keysFor(teamDomain), {
      issuer: `https://${teamDomain}`,
      audience: aud,
      algorithms: ["RS256"],
    }));
  } catch {
    return deny(401, "Invalid Cloudflare Access token");
  }

  const claims = AccessClaims.safeParse(payload);
  if (!claims.success) return deny(401, "Invalid Cloudflare Access token");

  if ("email" in claims.data) {
    const email = claims.data.email;
    return {
      ok: true,
      principal: { kind: "human", subject: email, scopes: admins.has(email.toLowerCase()) ? READ_MUTATE : READ },
    };
  }
  // Service tokens are agents: read-only, whatever the admin list says.
  return { ok: true, principal: { kind: "agent", subject: claims.data.common_name, scopes: READ } };
}
