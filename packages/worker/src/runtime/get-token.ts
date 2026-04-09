/**
 * Extract the auth token from a WebSocket upgrade request.
 * The Actor Kit client SDK sends the token via Sec-WebSocket-Protocol header
 * as `auth.<token>` alongside the framework's `actor-kit.v1` subprotocol.
 *
 * Returns null if no token is present.
 *
 * The library does NOT validate the token — that's your responsibility.
 * Validate it against your auth system (JWT, opaque session, etc.) before
 * stamping caller identity with withCallerIdentity().
 */
export function getTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("Sec-WebSocket-Protocol");
  if (!header) return null;
  const protocols = header.split(",").map((p) => p.trim());
  const authProtocol = protocols.find((p) => p.startsWith("auth."));
  if (!authProtocol) return null;
  return authProtocol.slice("auth.".length);
}
