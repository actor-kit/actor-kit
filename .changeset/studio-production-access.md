---
"@actor-kit/studio": minor
"@actor-kit/worker": minor
"@actor-kit/studio-cli": minor
---

Studio production access (ADR-014). `/__studio` is authenticated with Cloudflare Access (SSO for people, one service token per agent); the `X-Actor-Kit-Studio-Key` header and `ACTOR_KIT_STUDIO_SECRET` are removed. Agents are read-only and see hashed callers (`STUDIO_CALLER_HASH_KEY`). Actors declare `studio: { redact: [...] }` path globs, applied in the Durable Object to everything Studio returns. Every Studio request emits a `studio.request` audit event. New `GET /__studio/api/actors/:type/:id/view` route, and the new `@actor-kit/studio-cli` package (`actor-kit studio list|types|inspect|timeline|view` and the `actor-kit-studio-mcp` server).
