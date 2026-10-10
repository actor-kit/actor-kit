# System Architecture

## Overview

Actor Kit v2 is a framework for building real-time, event-driven applications on Cloudflare Durable Objects. Each actor is a DO with:
- A **mailbox** (message queue — DO handles this natively)
- **Private state** (persisted to DO SQLite)
- **Behavior** you define (transitions, roles, views)
- **Binary sync** (schema-encoded delta frames over WebSocket)

## Module boundaries

```
packages/
├── core/              schema() builder, type primitives, binary codec, shared types
├── worker/            defineActor(), createActorClass(), message(), DO runtime, identity
├── client/            actorClient(contract).create(), subscribe, send, reconnection
├── react/             actorContext(contract), useView(), useSend(), useRole(), Provider
├── test/              testActor(contract), send() with effect capture, view assertions
└── storybook/         withActorKit() Storybook decorator, mock client
```

### Dependency flow

```
@actor-kit/core ← @actor-kit/worker        (server-side, imports cloudflare:workers)
@actor-kit/core ← @actor-kit/client         (browser-side, no CF deps)
@actor-kit/core ← @actor-kit/react          (browser-side, imports react)
@actor-kit/core ← @actor-kit/test           (test-time, no CF deps for unit tests)
```

Critical constraint: `@actor-kit/client`, `@actor-kit/react`, and `@actor-kit/test` must NEVER import from `@actor-kit/worker`. The worker package imports `cloudflare:workers` which cannot ship to browsers or run in plain Node.

### Package exports

Each package is published independently under the `@actor-kit/*` scope:
- `@actor-kit/core` — schema primitives, types, binary codec
- `@actor-kit/worker` — `defineActor()`, `createActorClass()`, `message()`, `withCallerIdentity()`
- `@actor-kit/client` — `actorClient(contract).create()`, browser-safe WebSocket client
- `@actor-kit/react` — `actorContext(contract)`, React hooks and Provider
- `@actor-kit/test` — `testActor(contract)`, test harness
- `@actor-kit/storybook` — `withActorKit()` Storybook decorator

## Type system

### The `defineActor()` + `createActorClass()` pattern

```typescript
import { defineActor, createActorClass, message } from "@actor-kit/worker";

// defineActor() returns a typed contract (not a DO class)
const counter = defineActor({
  init: () => ({ count: 0 }),
  roles: { anyone: () => true },
  messages: {
    anyone: {
      increment: message(z.object({}), (state) => ({ ...state, count: state.count + 1 })),
    },
  },
  views: { /* ... */ },
});

// createActorClass() converts contract → DO class
export const Counter = createActorClass(counter);
```

Key type relationships:

```
TState       ← inferred from init() return type
TRoles       ← inferred from roles object keys + predicates
TMessages    ← constrained to keys of TRoles, values are Record<string, MessageDef>
TViews       ← constrained to keys of TRoles, view functions receive TState
TView (union) ← computed: { role: R } & Infer<TViews[R]["schema"]> for each R in TRoles
TAllMessages ← union of all message types across all roles (what the client sees)
```

### The `message()` helper

```typescript
function message<TSchema extends z.ZodType, TState>(
  schema: TSchema,
  handler: (state: TState, payload: z.infer<TSchema>, ctx: MessageContext) => TState,
): MessageDef<z.infer<TSchema>, TState>;
```

Every message handler must be wrapped in `message()` to pair a Zod schema with the handler. The schema is used at runtime for boundary parsing — invalid payloads are rejected before the handler runs.

### MessageContext

```typescript
type MessageContext = {
  caller: string;              // "user-123" — from identity headers
  callerType: "user" | "service";  // from identity headers (stable identity, not authorization)
  role: string;                // "owner" — computed from state by role predicates
  env: TEnv;                   // Worker env bindings (queues, AI, secrets, etc.)
  emit: EmitFn;                // (effect) → void — transactional outbox (legacy)
  execute: ExecuteFn;           // (service) → void — transactional outbox
  now(): number;                // one timestamp per transition, recorded in the journal
  id(): string;                 // fresh UUID, recorded in the journal
  random(): number;             // [0, 1), recorded in the journal
};
```

`now`/`id`/`random` (`DeterministicContext`) are also passed to `init`, lifecycle handlers, and as a trailing `ctx` argument to `onDone`, `onError`, `link.onUpdate`, `link.onError` and `link.onUnlink`. Handlers must use them instead of `Date.now()`, `Math.random()` or `crypto.randomUUID()` so the journal can replay them (ADR-013).

### RolePredicate

```typescript
type RolePredicate<TState> = (
  state: TState,
  caller: string,
  claims: { callerType: "user" | "service" },
) => boolean;
```

Role predicates receive `callerType` from identity headers for distinguishing service vs user callers. Authorization is still derived from state — `callerType` is identity metadata, not a role.

### Schema type inference

```typescript
const MyView = schema({
  count: uint32,        // SchemaField<"uint32", number>
  name: string,         // SchemaField<"string", string>
  items: array(Item),   // SchemaField<"array", Infer<typeof Item>[]>
});

type MyViewType = Infer<typeof MyView>;
// { count: number; name: string; items: ItemType[] }
```

`Infer<T>` extracts the TypeScript type from a schema definition. This is compile-time only — no runtime overhead.

### Role-scoped view union

```typescript
// Given:
views: {
  owner: view.shared(OwnerView, fn),
  viewer: view.shared(ViewerView, fn),
},

// The framework computes:
type TView =
  | { role: "owner" } & Infer<typeof OwnerView>
  | { role: "viewer" } & Infer<typeof ViewerView>;

// Client code narrows via discriminant:
if (view.role === "owner") {
  view.todos;  // typed
}
```

## Runtime lifecycle

### Actor creation

```
1. HTTP request arrives at Worker
2. Worker stamps identity via withCallerIdentity(request, { callerId, callerType })
3. Worker forwards to DO via stub.fetch(stampedRequest)
4. DO activates (or wakes from hibernation)
5. If first spawn:
   a. Validate input against Zod schema
   b. Run init(input) → initial state
   c. Persist state to SQLite
   d. Persist actor metadata (name, id, version)
6. If already spawned: no-op (idempotent)
```

### Message processing

```
1. WebSocket frame (or send() RPC) arrives; the frame is parsed: an object with a string `type`
2. Caller identity from the socket's tags (stamped by the Worker via withCallerIdentity)
3. Resolve caller role: iterate roles top-to-bottom, first match wins
4. admitMessage(): the message exists for the role, the payload parses with its Zod schema, the guard passes
5. step(): run the handler with { caller, callerType, role, env, now, id, random, execute, link, unlink, forward },
   then onUnlink for each unlink → { state, effects, event }
6. commit(): BEGIN
     seq = nextTransitionSeq()
     executions + forwards (ids seq:index), active_links writes
     snapshot (last_seq = seq) + journal event (seq)
   COMMIT
7. Compute view for each connected caller (may differ per role), diff, encode, send
8. Drain executions and forwards (async, outside the transaction)
```

### The step core (ADR-015 D4)

`runtime/step.ts` holds one transition as a pure function: `step(def, state, cause, facts, env) → { state,
handlerState, effects, event }` for messages, lifecycle connect/disconnect, service onDone/onError, link
onUpdate/onError and migration, and `stepInit()` for init (which may be async). It reads the outside world only
through `facts`:

- `ctx.now()/id()/random()`: live they read the clock/RNG and record what they returned; on replay they hand the
  recorded values back (`liveStepFacts` / `replayStepFacts`).
- `unlinkTargets(name, pending)`: the targets of an `unlink(name)` with no id. Live, the stored links in insertion
  order, plus this transition's links, minus what earlier unlinks removed (`liveUnlinkTargets`); on replay, the
  recorded list.

`effects` is the outbox collector (executions and forwards share one effect index; links and unlinks apart).
`event` is the journal draft, facts included. The Durable Object only adds I/O around it: admission, storage
(commit), alarms, broadcasting. `applyJournalEvent()` (replay) maps each journal event back to a step cause and runs the same function, so the
runtime and replay cannot drift apart. Because `actor.ts` is excluded from
Stryker (it imports `cloudflare:workers`), everything worth mutating lives in `runtime/`. That includes the
socket-facing checks: `connect-request.ts` (Upgrade header, caller identity headers, binary flag, subprotocol),
`close-code.ts` (the code that answers a client's close), `actor-def.ts` (the definition shape check) and
`studio-registry.ts` (finding the StudioRegistry). `actor.ts` itself is covered by the integration tests;
`pnpm crap:worker` scores its CRAP with unit and integration (istanbul, workerd) coverage combined.

### WebSocket lifecycle

```
Connect:
  1. Extract caller identity from headers (Worker-trust) or JWT (fallback)
  2. Resolve role (reject with 403 if no match)
  3. Register WebSocket in connections map (keyed by caller)
  4. Send SNAPSHOT frame (full binary state for this caller's view)
  5. Run lifecycle.connect(state, { caller, callerType, callerConnections }, ctx) if defined
     (callerConnections = this caller's open sockets, including this one)
  6. Persist state if connect handler changed it
  7. Broadcast view updates to ALL connected callers

Disconnect:
  1. Run lifecycle.disconnect(state, { caller, callerType, callerConnections }, ctx) if defined
     (callerConnections = this caller's open sockets, excluding the closing one; 0 = last tab closed)
  2. Persist state if disconnect handler changed it
  3. Remove WebSocket from connections map
  4. Broadcast view updates to remaining callers

Reconnect:
  1. Client sends { lastChecksum, schemaVersion }
  2. If schema version mismatch: send SCHEMA_CHANGED + SNAPSHOT
  3. If checksum matches recent: send DELTA from that point
  4. If checksum unknown: send full SNAPSHOT
  5. Re-run role evaluation (may have changed)
```

### Persistence model

SQLite tables in the DO:

```sql
CREATE TABLE actor_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Keys: "name", "id", "version", "created_at"

CREATE TABLE snapshots (
  version INTEGER PRIMARY KEY,
  state BLOB,
  checksum TEXT,
  updated_at INTEGER
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  type TEXT,
  payload TEXT,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  created_at INTEGER,
  last_attempt_at INTEGER
);

CREATE TABLE emission_failures (
  id TEXT PRIMARY KEY,
  type TEXT,
  payload TEXT,
  error TEXT,
  failed_at INTEGER
);
```

### Event journal (ADR-013)

The `snapshots` row is a cache. Every transition that persists state goes through `commit()`, which in one `transactionSync` runs the outbox/link writes, writes the snapshot and appends one row to `events` (`runtime/journal.ts`):

```sql
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  cause_type TEXT NOT NULL,   -- init | message | lifecycle.* | service.onDone/onError | link.onUpdate/onError | migrate
  name TEXT,                  -- message type, service name or link name
  payload TEXT NOT NULL,      -- parsed payload / input / { input, result } / { sourceId, view } ...
  caller TEXT, caller_type TEXT, role TEXT,
  facts TEXT NOT NULL,        -- { now, ids, randoms, unlinked, linkViews } read by the handler
  code_version INTEGER NOT NULL,
  state_checksum TEXT NOT NULL, -- xxh64 of the persisted after-state JSON
  created_at INTEGER NOT NULL
);
CREATE TABLE journal_checkpoints (seq INTEGER PRIMARY KEY, version INTEGER, state TEXT, checksum TEXT);
```

- A failed commit writes nothing and puts the in-memory state back.
- A checkpoint (after-state) is written every `checkpointEvery` events (default 100).
- `journal: false` turns it off; `journal: { keep }` prunes events at or below the newest checkpoint `<= lastSeq - keep`.
- `readJournal(sql)` and `applyJournalEvent()` (`@actor-kit/worker/testing`) and `replayJournal()` (`@actor-kit/test`) read and fold it. Replay never runs guards or side effects.

### Transactional outbox and retries (ADR-003, ADR-015 D1)

Every effect a transition declares (`execute`, `forward`) gets an **effect id** `seq:index`: `seq` is the
transition's number, read inside the commit by `nextTransitionSeq()` (one past the larger of
`snapshots.last_seq` and the journal's high-water mark, so it also works with `journal: false`), and `index` counts
the transition's effects in declaration order. Rows in `executions` and `forwards` are keyed by it and sort by
`(seq, idx)` as integers. Modules: `runtime/effect-id.ts`, `runtime/outbox.ts` (collector),
`runtime/outbox-store.ts` (SQL), `runtime/retry.ts` (policy), `runtime/migrations.ts` (schema).

```
Transition → commit(): BEGIN
    seq = nextTransitionSeq()
    INSERT executions/forwards (id = seq:index, status pending)
    INSERT OR REPLACE snapshots (…, last_seq = seq) + INSERT events (seq, …)
  COMMIT → syncAlarm() → drainExecutions() (async)

drainExecutions(): until no row is due
  due = pending, or retrying with next_attempt_at <= now (ORDER BY seq, idx)
  for each: startAttempt (status running, attempts + 1)
            fn(input, env, { actorType, actorId, effectId, idempotencyKey, attempt, signal })  (ADR-016)
            settleAttempt(outcome, attempt, policy):
              ok          → done   (+ onDone transition, same transaction as the row update)
              failed, more tries left → retrying, next_attempt_at = now + backoff; syncAlarm()
              failed, last try        → failed (+ onError transition); log actor_kit.outbox.failed

alarm(): drain due rows, then syncAlarm() (one alarm: the earliest next_attempt_at, or none)
wake:    rows left running by a crash go back to pending (at-least-once), then drain
redrive: __redrive({ effectId }) / Studio action — failed → pending, attempts 0, same effect id
```

Retry policy per service: `retry: { attempts, backoff: { baseMs, factor, maxMs, jitter } }`, default 3 tries,
1s then 5s apart, ±20% jitter. `failed` is final: failed rows are the dead letters.

Forwards (`ctx.forward`) follow the same lifecycle in the `forwards` table: `drainForwards()` sends due rows
(`dueForwards`), counts tries with the same `startAttempt`/`finishAttempt` (table `forwards`) and settles them with the
link's policy (`link(Contract, { retry })`, same shape and defaults; undeclared links get the default). A send that
throws is retried on the shared alarm (`nextRetryAt` is the earliest across both tables); a target that cannot be
resolved or a stored message that is not a message is a dead letter at once. A target that answers, even with a
refusal, is `done`. Each try passes the forward's effect to the target's `send(caller, callerType, message, delivery)`
(ADR-016 §1: `{ actorType, actorId, effectId, idempotencyKey, attempt }`, parsed there); the target's handler reads it
as `ctx.delivery`, journaled as the `delivery` fact. Redrive takes either kind by effect id, and Studio's Outbox lists both (forwards carry
`kind: "forward"`, the link as `service` and their `target`).

### Restore and replay on wake (ADR-015 D3)

`runtime/restore.ts` plans, `actor.ts` commits:

```
__restore({ toSeq })  (Studio mutate scope; journal required)
  plan = planRestore(def, readJournal(), toSeq)
    start: newest checkpoint <= toSeq (checksum verified, with its pending timers) or init
    foldEvents(start .. toSeq): state + pending timers; `restore` events jump back to their toSeq
    redeliver: service results recorded after toSeq whose effectId seq <= toSeq (first per effect)
  commit(plan.state, restore event { toSeq }):
    timers table := plan.timers (original ids and fire_at; overdue ones fire on the next alarm)
    executions/forwards with seq > toSeq still pending/retrying/running := failed
      ("cancelled: the actor was restored to seq N"; a try in flight is not settled)
  each redeliver: onDone/onError with the recorded result as a new event (the service is not called)
```

On wake, when `snapshots.last_seq` is behind the journal at the same code version, `catchUpJournal()` folds
the journal from its newest usable checkpoint and rewrites the snapshot. Timeline rows carry the journal `seq`
they recorded, which Studio uses for "Restore to here".

### Versions (ADR-015 D5)

`versions: [version(n, Schema, { state, events, rebuild })]` is compiled by `toRuntimeDef()` (`runtime/versions.ts`)
when a definition becomes a DO class (`actor()`, which `createActorClass` calls), a simulation or a replay: `version` (the last), `migrate`
(parse with the old version's schema, then each `state` step parsed by its version's schema), `upcast` (message
payloads through every later `events` map), `knownVersions` and `rebuildVersion`. A definition with the old
`version` / `migrate` keys is refused, by `actor()` as well as by contracts: `versions` is the only path.

On wake with an older stored version: `migrate` through the step core, or, across a `rebuild: "replay"` version,
`rebuildFromJournal()` (whole journal, current handlers, payloads upcast, no checksum comparison) in
`catchUpJournal()`. Either way a `migrate` event is appended, always with a checkpoint. `foldJournal()` checks every
event's `code_version` is in the chain and not newer than the current one, and, when older versions wrote some
events, starts at the last bump's checkpoint. Restore refuses a seq written by an older version.

### Actor-to-actor communication (DO RPC)

```typescript
// Calling actor:
const other = ref(env, "zone", "forest-north");
await other.call("ACCEPT_TRANSFER", { callerId, playerData });

// Under the hood:
// 1. ref() returns a typed stub wrapping env.ZONE.get(env.ZONE.idFromName("forest-north"))
// 2. call() invokes the RPC method on the target DO
// 3. Target DO runs the rpc handler as a transition
// 4. Result (or error) propagates back to caller
```

RPC handlers live in the `rpc` block. They are NOT exposed to WebSocket clients. They don't go through role evaluation (the calling actor is trusted).

### Timers (ADR-015 D2)

`ctx.schedule(name, { in | at, key, payload })` and `ctx.cancel(key)` are effects of the transition: the step
core validates the name and payload, computes `fire_at` (`ctx.now() + in`, so replay computes the same deadline)
and records them in declaration order with an effect index. `commit()` applies them to the `timers` table (one
row per pending timer: `id` = effect id, unique `key`, `payload`, `fire_at`; scheduling an existing key replaces
it) in the same transaction.

```
syncAlarm() (after every commit and settled try): setAlarm(min(next timer, next outbox retry)) or deleteAlarm()
alarm():
  scheduledBy = last committed seq
  while dueTimer(now, scheduledBy):        -- ORDER BY fire_at, seq, idx; late timers included
    step({ type: "timer", name, id, key, payload, fireAt, lateBy }, clock = now)
    commit: DELETE the timer row, write its effects, journal event cause_type "timer"
  drain due outbox retries; syncAlarm()
```

Timers a firing schedules have a later seq than `scheduledBy`, so they wait for the next alarm. A timer that
cannot fire (payload no longer parses, transition fails) is deleted and logged (`actor_kit.timer.failed`). Studio
reads the table (`__inspect().timers`, `studio.timers` frames, payloads redacted) and can fire one now
(`__fireTimer({ key })`, mutate scope).

### Throughput limits

Each actor (DO instance) is single-threaded. Approximate capacity per actor:

| Operation type | Throughput |
|---|---|
| Simple pass-through | ~1,000 msg/sec |
| Moderate processing (validation, routing) | ~500–750 msg/sec |
| Complex operations (storage writes, broadcasts) | ~200–500 msg/sec |

Design actors around your coordination boundary — one DO per chat room, game session, document, or user — not one global DO. If a single actor exceeds these limits, shard across multiple actors keyed by a natural partition (room shard, region, etc.).

## Authentication flow

```
Client                    Worker                    DO
  │                         │                        │
  │ Request                 │                        │
  │ (with app auth)         │                        │
  │────────────────────────>│                        │
  │                         │ Authenticate caller    │
  │                         │ withCallerIdentity()   │
  │                         │ stamps X-Actor-Kit-*   │
  │                         │ headers on request     │
  │                         │───────────────────────>│
  │                         │                        │ Extract identity from headers
  │                         │                        │ Resolve role
  │<─────────────────────────────────────────────────│
  │ SNAPSHOT (binary)       │                        │
```

Identity model:
- Worker authenticates the caller (session cookie, OAuth, etc.)
- Worker stamps identity via `withCallerIdentity(request, { callerId, callerType })`
- DO trusts the Worker — extracts identity from `X-Actor-Kit-Caller-Id` / `X-Actor-Kit-Caller-Type` headers
- `withCallerIdentity()` scrubs any inbound identity headers first (prevents client spoofing)
- CORS/Origin validation is handled at the Worker level (e.g., Hono `cors()` middleware), not inside the actor
- JWT via `Sec-WebSocket-Protocol` is available as a fallback for external clients
