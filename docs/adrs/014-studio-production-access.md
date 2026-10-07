# ADR 014: Studio Production Access (Cloudflare Access, scopes, redaction, audit)

**Date**: 2026-10-07
**Status**: Accepted
**Supersedes**: the shared `X-Actor-Kit-Studio-Key` header (bug bash open decision #1)
**Related**: ADR-002 (parse at boundary), Actor Journal (restore = first mutation)

## Context

Production Studio was gated by one shared secret in an `X-Actor-Kit-Studio-Key` header.

- Browsers can't send a custom header on a page load or on a WebSocket upgrade, so production
  Studio was unusable from a browser.
- The key was all-powerful and shared. An agent holding it could do anything a person could, and
  rotating it meant breaking every holder at once.
- Actor state can contain children's names (the family games). Anything Studio returns can end up
  in an agent transcript or, through `/sre-agent`, in a GitHub issue on a public repo.

People (in a browser) and agents (Claude sessions, the `/sre-agent` GitHub Actions job) both need
to debug live actors.

## Decision

### 1. Cloudflare Access in front of `/__studio`

- An Access application covers `<host>/__studio*`. People sign in with SSO (the `CF_Authorization`
  cookie, which the browser sends on page loads and WebSocket upgrades). Each agent gets **its own
  service token** (`CF-Access-Client-Id` / `CF-Access-Client-Secret`), so tokens can be revoked one
  at a time.
- Access forwards a signed JWT to the origin in `Cf-Access-Jwt-Assertion`. The middleware verifies
  it with `jose` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`: RS256,
  `iss` = the team URL, `aud` = the application's AUD tag, and `exp`/`nbf`. Access at the edge is
  not trusted on its own. The Worker may also be reachable on `*.workers.dev` or another route
  without Access.
- Configuration is env-only:

  | Var | Meaning |
  |---|---|
  | `STUDIO_ACCESS_TEAM_DOMAIN` | e.g. `mumm.cloudflareaccess.com` |
  | `STUDIO_ACCESS_AUD` | AUD tag of the Studio Access app |
  | `STUDIO_ADMIN_EMAILS` | comma-separated emails granted `mutate` |
  | `STUDIO_CALLER_HASH_KEY` | secret HMAC key for caller hashing (below) |

- **The shared key header is removed.** Nothing reads `X-Actor-Kit-Studio-Key` or
  `ACTOR_KIT_STUDIO_SECRET` any more. No shim, because the project is greenfield.
- **Localhost dev mode stays.** If no Access config is set and the URL hostname is exactly
  `localhost` or `127.0.0.1`, the request is allowed as the `dev` principal (read + mutate). If no
  Access config is set and the host isn't local, the response is 403 "not configured". If Access
  is configured, every request needs a valid JWT, localhost included.

### 2. Principals and scopes

| JWT | Principal | Scopes |
|---|---|---|
| user (`email` set) in `STUDIO_ADMIN_EMAILS` | `human` | `read`, `mutate` |
| user, not an admin | `human` | `read` |
| service token (`sub` = "", `common_name` = client id) | `agent` | `read` |
| dev mode | `dev` | `read`, `mutate` |

- Service tokens **never** get `mutate`, whatever env says. Today every route is a read
  (GET/HEAD). The first mutation, Actor Journal restore, will call `requireScope("mutate")`.
- WebSocket upgrades are `read`. Studio sockets can only send `studio.requestView`.

### 3. Server-side redaction, declared on the actor

```ts
studio: { redact: ["players.*.name", "**.email", "kids"] }
```

- Path globs: `*` matches one key or array index, `**` matches zero or more segments. The pattern
  list is validated when the actor is defined.
- The same list applies, each relative to its own root, to:
  - state (inspect, timeline snapshots, the WS snapshot and live timeline pushes)
  - every timeline `causeData` (message payloads, service input/output/error, link views)
  - outbox payloads
  - role views (the `view` route and the WS `studio.requestView` reply)
- A matched value is replaced with `"[redacted]"`, whatever its type. A matched object or array
  disappears whole.
- Redaction runs **inside the Durable Object** before data is returned over RPC or sent on a socket.
  Raw values never reach the middleware, the network or the browser. **Nobody** gets unredacted
  values over Studio, people included. Raw access is `wrangler`/SQLite only.
- Diffs are computed in the UI from the redacted snapshots, so they are redacted by construction.
  A change inside a redacted value doesn't show up in the diff. The entry's `checksum` (a hash of
  the full, unredacted state) still changes, which tells you *something* changed.
- **Caller hashing for agents.** Callers are JWT `sub` values and may be names. For the `agent`
  principal, every caller (connections, `caller` in causes, the `view` route's echoed caller) is
  replaced with `caller:<first 12 hex chars of HMAC-SHA256(STUDIO_CALLER_HASH_KEY, caller)>`. The
  hash is stable, so an agent can still see that the same caller did X and then Y. Without the
  key it can't be reversed or guessed by brute force. People see raw callers. The middleware
  tells the DO who the viewer is (an RPC argument, or a stamped header on the WS, with any inbound
  copy removed).
  - If `STUDIO_CALLER_HASH_KEY` is unset in production, agent requests are refused with 503. They
    never fall back to raw callers.

### 4. Audit wide-event per Studio request

Every request that reaches the Studio middleware emits one `console.log` JSON line (Workers Logs):

```json
{ "event": "studio.request", "principal": "agent", "subject": "<client id | email | dev>",
  "method": "GET", "route": "timeline", "actorType": "game", "actorId": "abc",
  "status": 200, "durationMs": 12, "outcome": "ok" }
```

- `subject` is the email for people. For agents it is the service token's client id, which
  identifies the token, not a secret.
- The line never includes response bodies, query values other than the route parameters, or the
  JWT.
- Denials (401/403) are logged too, with `principal: "anonymous"`.

### 5. Read-only CLI and MCP server (`@actor-kit/studio-cli`)

- `actor-kit studio list|inspect|timeline|view` and `actor-kit-studio-mcp` (stdio) expose the
  same four tools over `/__studio/api/*`.
- Auth is `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` (service token) or `CF_ACCESS_TOKEN`
  (a person's token from `cloudflared access token -app=<url>`).
- Responses are parsed with Zod.
- One new read-only route backs `view`: `GET /__studio/api/actors/:type/:id/view?role=&caller=`
  (`__getView` RPC, which reuses `handleStudioFrame`'s view logic and redaction).

### 6. Plan: shard StudioRegistry by actor type (not built here)

There is a single global `StudioRegistry` DO (`idFromName("registry")`). Every actor's debounced
touch goes through that one DO, which caps throughput at one DO's (~1k req/s) and makes it a
single point of contention.

1. Registry instance per type: `idFromName("registry:" + actorType)`. Actors already know their
   type, so they write to their own shard. `hasActor(type, id)`, `listActors({type})` and the `view`
   and `inspect` existence checks go straight to one shard.
2. A tiny index DO (`idFromName("registry:index")`) holds the set of known types. A shard registers
   its type there on its first insert. `getActorTypes()` reads the index.
3. `listActors()` without a type fans out to each shard listed in the index (bounded by
   `limit`) and merges by `lastActivity`. The UI already filters by type, so the fan-out is
   rare.
4. Migration: there is no production data worth keeping (greenfield). The new shards fill up as
   actors touch them.
5. Hot single type later: add a hash suffix (`registry:game:<0..N>`) behind the same API.

## Consequences

- Production Studio works from a browser (SSO cookie) and from agents (service tokens), without a
  shared secret.
- Existing tests that encode header-key behaviour are rewritten as their Access equivalents.
  This was approved by Jon on 2026-10-07. The changed tests are:
  - `tests/unit/studio-middleware.test.ts`: "rejects non-localhost without secret" (still 403;
    the trigger becomes "no Access config"), "rejects with wrong secret" (becomes invalid JWT →
    401) and "allows with correct secret" (becomes valid JWT → 200)
  - the key cases in `tests/unit/studio-middleware-routing.test.ts` and
    `tests/integration/studio-middleware.test.ts`
- The UI's key prompt goes away. A 401/403 tells the person to sign in through Access.
- Redaction is opt-in per actor. An actor with no `redact` list exposes its full state to anyone
  with `read`. Games with children's data must declare one. The `/sre-agent` integration never
  puts values in issues anyway (see `docs/specs/studio-sre-agent.md`).
- The checksum stays a hash of unredacted state. With low-entropy state (e.g. a single redacted
  field with a few possible values), someone could confirm a guess offline. We accept this,
  because the checksum is needed to correlate with logs, and the risk is that a guess is
  confirmed, not that a value leaks.

## Assumptions made explicit

- The Worker's other routes (the game itself) are **not** behind Access. Only `/__studio*` is.
- Cloudflare rotates the Access signing keys. `createRemoteJWKSet` caches them per isolate and
  refetches when it sees an unknown `kid`.
- Access sends `Cf-Access-Jwt-Assertion` on WebSocket upgrades as well as plain requests (the
  cookie is sent on the upgrade). This is unverified until the first real deploy and is listed in
  the setup commands.
- Agents never need raw values to fix a bug. Shape, changed paths, cause types and checksums are
  enough to write a regression test.
