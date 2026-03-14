# Testing Strategy

## Philosophy

- **TDD**: Red-green-refactor. Write the test first.
- **Seam testing**: Prefer integration tests at system boundaries over unit mocks.
- **Fakes over mocks**: Use `FakeDurableObjectState`, `FakeWebSocket`, `FakeStorage` — not `vi.fn()` mocks of internals.
- **Mutation testing**: Stryker validates test quality. Target: 80% mutation score (break threshold), 90% (high).
- **Never modify existing tests to make new code pass.** If new code breaks tests, the new code is wrong.

## Seam Boundaries

```
                    ┌─────────────┐
                    │  Browser    │
                    │  (client)   │
                    └──────┬──────┘
                           │
              Seam 1: WebSocket Protocol
              (JSON messages, JSON Patch ops)
                           │
                    ┌──────▼──────┐
                    │   Router    │
                    │  (Worker)   │
                    └──────┬──────┘
                           │
              Seam 2: HTTP/WebSocket → DO
              (Request routing, JWT validation)
                           │
                    ┌──────▼──────┐
                    │  Machine    │
                    │  Server     │
                    │  (DO)       │
                    └──────┬──────┘
                           │
              Seam 3: XState ↔ Storage
              (Snapshot persistence, migration)
                           │
                    ┌──────▼──────┐
                    │  Durable    │
                    │  Object     │
                    │  Storage    │
                    └─────────────┘
```

### Seam 1: Client ↔ Server (WebSocket)

**What crosses**: JSON event messages (client → server), JSON Patch operations (server → client)

**Test strategy**: `create-actor-kit-client.test.ts` uses a `FakeWebSocket` that simulates server messages. Tests verify:
- Event serialization and sending
- Patch application via `fast-json-patch` + Immer
- Reconnection with exponential backoff
- Checksum-based state tracking

**Fakes used**: `FakeWebSocket` (simulates open/message/close events)

### Seam 2: Router ↔ Durable Object

**What crosses**: HTTP requests (GET for snapshot, POST for events), WebSocket upgrade requests

**Test strategy**: `create-actor-kit-router.test.ts` tests the full request lifecycle:
- JWT validation (valid, expired, wrong audience)
- Actor spawning on first request
- Routing to correct DO by actor type and ID
- WebSocket upgrade handling

**Fakes used**: Mock Cloudflare `env` with stubbed DO namespace

### Seam 3: Machine Server ↔ Storage

**What crosses**: Serialized snapshots, actor metadata, persisted state

**Test strategy**: `create-machine-server.test.ts` uses `FakeDurableObjectState` and `FakeStorage`:
- Snapshot persistence on transition
- Snapshot restoration on resume
- Migration via `xstate-migrate`
- Snapshot cache lifecycle (5-minute TTL)
- Checksum calculation and deduplication

**Fakes used**: `FakeDurableObjectState` (in-memory Map), `FakeStorage`

## Test Files

| File | Lines | Seam | Focus |
|------|-------|------|-------|
| `create-machine-server.test.ts` | 432 | 3 | Snapshot caching, WebSocket messaging, persistence |
| `create-actor-kit-client.test.ts` | 414 | 1 | Connection, reconnection, state patching, event queueing |
| `create-actor-kit-router.test.ts` | 262 | 2 | Routing, spawning, auth, GET/POST/WebSocket |
| `create-actor-fetch.test.ts` | 236 | 2 | Server-side fetching, waitFor conditions |
| `utils.test.ts` | 172 | — | Token parsing, JWT verification, logging |
| `create-actor-kit-mock-client.test.ts` | 112 | — | Mock client produce(), subscriptions |
| `auth.test.ts` | 46 | 2 | Token validation edge cases |
| `schemas.test.ts` | 27 | — | CallerStringSchema parsing |

## Fake Implementations

### FakeWebSocket

Simulates a browser WebSocket. Supports:
- `send(data)` — captures sent messages for assertion
- `addEventListener(type, handler)` — registers handlers
- Programmatic event dispatch (open, message, close, error)
- `readyState` tracking

### FakeDurableObjectState

In-memory implementation of `DurableObjectState`:
- `storage.get(key)` / `storage.put(key, value)` — backed by a `Map`
- `storage.delete(key)` — removes entries
- `getWebSockets()` — returns tracked WebSocket connections
- `acceptWebSocket(ws)` — registers a WebSocket

### FakeStorage

Simplified storage for testing persistence:
- `get(key)` / `put(key, value)` / `delete(key)` — in-memory
- Tracks all writes for assertion

## Mutation Testing

### Configuration

```javascript
// stryker.config.mjs
mutate: [
  "src/createAccessToken.ts",
  "src/createActorFetch.ts",
  "src/createActorKitClient.ts",
]
```

**Currently covered**: 3 of ~20 source files.

**Priority expansion order**:
1. `src/createMachineServer.ts` — core state sync logic (highest value)
2. `src/createActorKitRouter.ts` — auth and routing
3. `src/utils.ts` — token parsing, JWT verification
4. `src/schemas.ts` — validation logic

### Running mutation tests

```bash
pnpm test:mutate              # Full run (slow)
pnpm test:mutate:incremental  # Only changed files (fast, for development)
```

### Thresholds

```javascript
thresholds: {
  high: 90,    // Green: 90%+ mutation score
  low: 80,     // Yellow: 80-90%
  break: 80,   // Build fails below 80%
}
```

## Storybook Testing

Actor-kit provides mock infrastructure for Storybook:

### Mock client (`actor-kit/test`)

`createActorKitMockClient<TMachine>` — same interface as real client, no network I/O:
- `send(event)` → triggers `onSend` callback
- `produce(recipe)` → Immer mutation, triggers re-render
- `getState()` → current snapshot
- `subscribe(listener)` → state change notifications

### Storybook decorator (`actor-kit/storybook`)

`withActorKit<TMachine>({ actorType, context })` — reads snapshot from `parameters.actorKit.{actorType}` and provides it via context.

### Patterns

1. **Static stories**: Set snapshot in `parameters.actorKit`, render component
2. **Interactive stories**: Create `createActorKitMockClient` in `play()`, mount with `ProviderFromClient`, use `produce()` to simulate state changes
3. **Multi-actor**: Nest multiple `ProviderFromClient` wrappers

See [Trivia Jam](https://github.com/actor-kit/trivia-jam) for comprehensive Storybook examples with play functions.

## Coverage Thresholds

```javascript
// vitest.config.ts
thresholds: {
  lines: 10,
  functions: 5,
  branches: 5,
  statements: 10,
}
```

These are intentionally low as the project grows. Increase as coverage improves.

## Gaps

- No E2E tests in the library itself (examples have Playwright tests)
- No chaos/resilience testing (network failures beyond basic reconnect)
- No actor-to-actor communication tests
- No time-dependent guard tests
- Mutation testing covers only 3 files
