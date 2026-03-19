# Architecture

Actor-kit runs XState state machines inside Cloudflare Durable Objects and synchronizes state to browser clients via WebSocket using JSON Patch diffs.

## System Diagram

```
Browser                           Cloudflare Worker
┌─────────────────────┐           ┌──────────────────────────────┐
│                     │           │                              │
│  createActorKitClient ──WSS───▶  createActorKitRouter          │
│  (WebSocket client) │           │  (request routing)           │
│       │             │           │       │                      │
│       ▼             │           │       ▼                      │
│  createActorKitContext          │  createMachineServer          │
│  (React hooks)      │           │  (Durable Object class)      │
│   • useSelector     │           │       │                      │
│   • useSend         │           │       ▼                      │
│   • useMatches      │           │  XState Actor Instance       │
│                     │           │       │                      │
│                     │           │       ▼                      │
│                     │           │  DurableObject Storage       │
│                     │           │  (snapshot persistence)      │
└─────────────────────┘           └──────────────────────────────┘

Server (SSR)
┌─────────────────────┐
│  createAccessToken   │  ← JWT signing (jose)
│  createActorFetch    │  ← HTTP GET for initial snapshot
└─────────────────────┘
```

## Data Flow

### 1. Initial page load (SSR)

```
Server loader
  │
  ├─ createAccessToken({ signingKey, actorId, actorType, callerId, callerType })
  │   → JWT with jti=actorId, aud=actorType, sub=callerType-callerId
  │
  ├─ createActorFetch({ actorType, host })
  │   → HTTP GET /api/{actorType}/{actorId}?accessToken=...
  │   → Router validates JWT → spawns or retrieves DO
  │   → DO returns { checksum, snapshot } (caller-scoped)
  │
  └─ Returns to component: { accessToken, checksum, snapshot }
```

### 2. Client hydration

```
React component
  │
  ├─ <Provider host, actorId, accessToken, checksum, initialSnapshot>
  │   → createActorKitClient({ initialSnapshot, ... })
  │
  └─ useEffect → client.connect()
      → WebSocket: wss://host/api/{actorType}/{actorId}?accessToken=...&checksum=...
      → Server validates JWT
      → If checksum matches: no initial payload (client is current)
      → If checksum differs: full snapshot sent
      → Ongoing: JSON Patch operations for each state change
```

### 3. Event processing

```
Client                          Durable Object
  │                               │
  │ send({ type: "ADD_TODO" })    │
  │ ────────WSS──────────────▶    │
  │                               │ 1. Parse event (Zod schema)
  │                               │ 2. Validate caller (JWT claims)
  │                               │ 3. Augment: { ...event, caller, storage, env }
  │                               │ 4. actor.send(augmentedEvent)
  │                               │ 5. XState transitions (guards → actions → state)
  │                               │ 6. getSnapshot() → calculateChecksum()
  │                               │ 7. For each connected WebSocket:
  │                               │    a. Create caller-scoped snapshot
  │                               │    b. Compare with last sent checksum
  │                               │    c. If different: compute JSON Patch diff
  │                               │    d. Send patch operations
  │                               │ 8. If persisted: storage.put(snapshot)
  │  ◀──────JSON Patch────────    │
  │                               │
  │ applyPatch(state, ops)        │
  │ → immer produce()             │
  │ → useSyncExternalStore        │
  │ → React re-render             │
```

### 4. Reconnection

```
Client detects WebSocket close
  │
  ├─ Exponential backoff (max 5 attempts)
  │
  └─ Reconnect with last-known checksum
      → Server checks snapshot cache (5-minute window)
      → If cached: send diff from cached state
      → If expired: send full snapshot
```

## Module Boundaries

| Module | Entry point | Responsibility | Dependencies |
|--------|-------------|----------------|-------------|
| Types & schemas | `@actor-kit/types` | Type definitions, Zod schemas, shared constants | zod, xstate (types only) |
| Machine server | `@actor-kit/worker` | DO class factory, XState lifecycle, persistence, WebSocket management | xstate, fast-json-patch, xstate-migrate, jose |
| Router | `@actor-kit/worker` | HTTP/WebSocket request routing, JWT validation, DO spawning | jose, zod |
| Browser client | `@actor-kit/browser` | WebSocket connection, reconnection, state patching, event queuing | fast-json-patch, immer |
| React bindings | `@actor-kit/react` | Context, Provider, hooks (useSelector, useSend, useMatches) | react |
| Server utilities | `@actor-kit/server` | JWT creation, HTTP state fetching | jose |
| Test utilities | `@actor-kit/test` | Mock client with Immer-based state control | immer |
| Storybook | `@actor-kit/storybook` | `withActorKit` decorator, parameter-based snapshots | react |

## Type System

The type system enforces that events, context, and snapshots are aligned at compile time.

```
ActorKitStateMachine<TEvent, TInput, TContext>
  │
  ├─ TEvent = ClientEvent | ServiceEvent | SystemEvent
  │   augmented with: caller, storage, env, requestInfo
  │
  ├─ TInput = WithActorKitInput<TInputProps>
  │   augmented with: id, caller (initial creator)
  │
  └─ TContext = { public: {...}, private: Record<string, {...}> }
      │
      └─ CallerSnapshotFrom<TMachine>
          = { public, private[callerId], value }
          (what each client actually sees)
```

Key derived types:
- `ClientEventFrom<TMachine>` — events the browser can send
- `ServiceEventFrom<TMachine>` — events backend services can send
- `CallerSnapshotFrom<TMachine>` — snapshot shape for a specific caller
- `EnvFromMachine<TMachine>` — Cloudflare env bindings

## Sync Protocol

### Checksum-based deduplication

Every snapshot is hashed (currently 32-bit string hash). The server tracks the last checksum sent to each WebSocket. If the new checksum matches, no patch is sent.

```
Transition occurs
  → Full snapshot checksum: "a3f2b1"
  → WebSocket A last sent: "a3f2b1" → skip
  → WebSocket B last sent: "7d8e1c" → compute diff, send patch
```

### Snapshot cache

The server caches recent snapshots (keyed by checksum, 5-minute TTL) so reconnecting clients can receive a diff from their last-known state rather than a full snapshot.

### Caller-scoped snapshots

Before diffing, the full snapshot is filtered per-caller:

```typescript
callerSnapshot = {
  public: fullSnapshot.context.public,
  private: fullSnapshot.context.private[caller.id] ?? {},
  value: fullSnapshot.value,
}
```

Different callers may receive different patches for the same transition (if private data changed for one but not another).

## Persistence Model

When `persisted: true`:

1. **On spawn**: Actor metadata stored (`actorType`, `actorId`, `initialCaller`, `input`)
2. **On each transition**: Full snapshot persisted to `PERSISTED_SNAPSHOT_KEY`
3. **On resume** (DO restart): Snapshot restored, `xstate-migrate` applies schema migrations, `RESUME` system event sent
4. **Snapshot format**: `{ value, context: { public, private }, version? }`

## Authentication

JWT-based, stateless:

| Claim | Maps to | Purpose |
|-------|---------|---------|
| `jti` | Actor ID | Ties token to specific actor instance |
| `aud` | Actor type | Prevents cross-type token reuse |
| `sub` | `{callerType}-{callerId}` | Identifies the caller |
| `exp` | 30 days | Token lifetime |

Signing uses HS256 with `ACTOR_KIT_SECRET` from environment.
