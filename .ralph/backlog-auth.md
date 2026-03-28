# Auth Redesign Backlog

Replace JWT-based auth with Worker-trust model. Keep tokens as opt-in.

## Core principle

The Worker is the auth boundary. The DO trusts the Worker.
`withCallerIdentity(request, { callerId, callerType })` is the blessed pattern.
Tokens remain available for external clients / invite links / cross-Worker.

## Tasks

- [x] **1. Add withCallerIdentity helper** — Create `withCallerIdentity(request, { callerId, callerType })` in `packages/worker/src/identity.ts`. It scrubs any inbound `X-Actor-Kit-Caller-Id` / `X-Actor-Kit-Caller-Type` headers, then sets the verified identity. Returns a new Request. Export from `@actor-kit/worker`. Write tests: scrubs existing headers, sets new ones, preserves request body/method. Run `pnpm typecheck && pnpm test:unit`.

- [x] **2. Update DO fetch to read from headers** — In `packages/worker/src/actor.ts`, change the WebSocket upgrade handler to read caller identity from `X-Actor-Kit-Caller-Id` and `X-Actor-Kit-Caller-Type` headers instead of parsing JWT from subprotocol. Return 401 with clear error if headers missing. Keep token path as fallback: if headers are absent but subprotocol has `token.*`, validate JWT. This lets both auth models work. Write integration tests. Run `pnpm typecheck && pnpm test:unit && pnpm test:integration`.

- [ ] **3. Make accessToken optional on client** — In `packages/client/src/client.ts`, make `accessToken` optional on `ClientOptions`. In `connect()`, only add the `token.*` subprotocol if `accessToken` is provided. Otherwise connect without subprotocol. Update `packages/client/src/builder.ts` — `CreateOptions` makes `accessToken` optional. Write tests: connect without token, connect with token (backwards compat). Run `pnpm typecheck && pnpm test:unit`.

- [ ] **4. Move token functions to opt-in export** — Move `createAccessToken` and `getCallerFromToken` from the main `@actor-kit/worker` export to `@actor-kit/worker/token` subpath export. Keep `jose` as an optional dependency. Update `packages/worker/package.json` with the subpath export. Update `packages/worker/src/index.ts` to remove token exports from main entry. Create `packages/worker/src/token.ts` that re-exports from auth.ts. Run `pnpm typecheck && pnpm test:unit`.

- [ ] **5. Remove ACTOR_KIT_SECRET from examples** — Update all 4 examples to use `withCallerIdentity` instead of `createAccessToken`. Remove the `/api/token` endpoint pattern. Remove `ACTOR_KIT_SECRET` from wrangler configs and `.dev.vars`. Each example should show: authenticate user → `withCallerIdentity(request, { callerId, callerType })` → forward to DO. Run examples to verify.

- [ ] **6. Update integration tests** — Update `tests/integration/src/worker.ts` to use `withCallerIdentity` instead of `createAccessToken`. Update all integration tests that use tokens. Run `pnpm test:integration`.

- [ ] **7. Update docs** — Update all docs pages: installation (remove ACTOR_KIT_SECRET), quick-start (withCallerIdentity, no token endpoint), examples (all 4), concepts (actors-and-state, side-effects), API reference (add withCallerIdentity, move token to opt-in section), FAQ. Build docs. The key message: "The Worker authenticates. The DO trusts the Worker."

- [ ] **8. Add Origin validation** — In the DO's WebSocket upgrade handler, validate the Origin header when using header-based auth (not tokens). Reject cross-origin WebSocket upgrades to prevent CSRF. Configurable via an `allowedOrigins` option on the actor definition. Write integration tests. Run `pnpm typecheck && pnpm test:unit && pnpm test:integration`.

- [ ] **9. Final verification** — Run full suite: pnpm typecheck, pnpm test:unit, pnpm test:integration, pnpm lint, docs build. Commit with detailed message.
