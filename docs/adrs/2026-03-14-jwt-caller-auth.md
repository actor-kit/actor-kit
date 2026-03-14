# JWT-Based Caller Authentication

**Date**: 2026-03-14
**Status**: Accepted (retrospective)
**Deciders**: Jonathan Mumm

## Context

Actor-kit needs to authenticate callers (browser clients, backend services) and associate each connection with a caller identity. The identity is used for:
- Scoping private context data
- Guard checks (e.g., `isOwner`)
- Tracking who is connected/disconnected

## Decision

Use JWTs signed with HS256, verified at both HTTP and WebSocket connection time.

Token structure:
- `jti` (JWT ID): Actor instance ID — ties token to a specific actor
- `aud` (audience): Actor type name — prevents cross-type reuse
- `sub` (subject): `{callerType}-{callerId}` — identifies the caller
- `exp`: 30 days from creation

Signed with `ACTOR_KIT_SECRET` from the Cloudflare Worker environment.

### Why

- **Stateless**: No session store needed. Token contains all claims. Verification is a single HMAC check.
- **Scoped**: Token is tied to a specific actor instance AND actor type. A token for "game-123" cannot access "game-456" or "session-123".
- **Simple**: `jose` library is lightweight, works in Workers runtime.

### Trade-offs

- **30-day expiry is long**: Acceptable for current use cases. Can be tightened per-deployment.
- **No refresh flow**: Tokens are created server-side (in SSR loaders). Client doesn't refresh them. If token expires mid-session, WebSocket reconnection will fail.
- **Shared secret**: All actors in a Worker share the same signing key. A compromised key affects all actors. Per-actor keys would add complexity without clear benefit today.

## Consequences

- Server (SSR loader) must call `createAccessToken()` before the client can connect
- Token is passed as query parameter on WebSocket upgrade: `?accessToken=...`
- Token replay is possible if not over HTTPS — enforce HTTPS in production
- Caller identity (`caller.id`, `caller.type`) is derived from JWT claims, not from user input
