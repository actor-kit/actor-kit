# Testing Strategy

## Testing trophy

Following Kent C. Dodds' testing trophy: more integration tests, fewer unit tests. Confidence over coverage.

```
          /\
         /  \        E2E (Playwright — future, not Phase 1)
        /----\
       /      \      Integration (vitest-pool-workers: real DO, real WS, real SQLite)
      /--------\
     /          \    Integration (testActor: transitions + roles + views, no CF runtime)
    /------------\
   /              \   Unit (schema encoder/decoder, auth, pure helpers)
  /----------------\
```

## Test levels

### Level 1: Unit tests (pure functions)

**What**: Schema encoder/decoder, identity helpers, role evaluation, individual message handlers.
**How**: Plain Vitest. No CF runtime, no network.
**Speed**: < 1ms per test.
**Location**: `tests/unit/`

```typescript
import { describe, it, expect } from "vitest";
import { schema, uint32, string, encode, decode } from "@actor-kit/core";

describe("schema encoder", () => {
  it("encodes uint32 as 4 bytes big-endian", () => {
    const MySchema = schema({ count: uint32 });
    const bytes = encode(MySchema, { count: 42 });
    expect(bytes).toEqual(new Uint8Array([0, 0, 0, 42]));
  });

  it("decodes uint32 from 4 bytes big-endian", () => {
    const MySchema = schema({ count: uint32 });
    const result = decode(MySchema, new Uint8Array([0, 0, 0, 42]));
    expect(result).toEqual({ count: 42 });
  });

  it("round-trips string encoding", () => {
    const MySchema = schema({ name: string });
    const data = { name: "hello" };
    expect(decode(MySchema, encode(MySchema, data))).toEqual(data);
  });
});
```

### Level 2: Actor logic tests (testActor)

**What**: Transitions, role resolution, view computation, emission capture. Full actor behavior without CF runtime.
**How**: `testActor()` from `@actor-kit/test`. Runs init, send, view in-process.
**Speed**: < 5ms per test.
**Location**: `tests/unit/` (they're still unit tests — no external deps)

```typescript
import { describe, it, expect } from "vitest";
import { testActor } from "@actor-kit/test";
import { todoContract } from "./todo-contract";

describe("TodoList actor", () => {
  const t = testActor(todoContract);

  it("initializes with empty todos", () => {
    t.init({ creator: "alice" });
    const view = t.view("alice");
    expect(view.todos).toEqual([]);
  });

  it("owner can add todo", () => {
    t.init({ creator: "alice" });
    t.send("ADD_TODO", { text: "Buy milk" });
    const view = t.view("alice");
    expect(view.todos).toHaveLength(1);
    expect(view.todos[0].text).toBe("Buy milk");
  });

  it("resolves owner role for creator", () => {
    t.init({ creator: "alice" });
    expect(t.role("alice")).toBe("owner");
  });

  it("resolves viewer role for unknown caller", () => {
    t.init({ creator: "alice" });
    expect(t.role("stranger")).toBe("viewer");
  });

  it("rejects messages not in caller's role", () => {
    t.init({ creator: "alice" });
    expect(() => {
      t.send("ADD_TODO", { text: "Nope" });
    }).toThrow(); // "stranger" is "viewer", viewer has no ADD_TODO
  });

  it("captures emissions from emit()", () => {
    t.init({ creator: "alice" });
    const { state, emissions } = t.send("NOTIFY_ALL", {});
    expect(emissions).toHaveLength(1);
    expect(emissions[0].type).toBe("queue");
  });
});
```

### Level 3: Integration tests (vitest-pool-workers)

**What**: Full DO lifecycle — WebSocket connection, binary frames, persistence, reconnection, outbox drain.
**How**: `@cloudflare/vitest-pool-workers`. Real Durable Objects, real SQLite, real WebSocket.

The repo is on Vitest 4.1, not 5: `@cloudflare/vitest-pool-workers` supports `vitest ^4.1` only, and on Vitest 5 Stryker's vitest-runner silently reports every call-time mutant as survived (verified: a mutant that fails all tests when activated by hand was reported "Survived"). Re-check both before moving to Vitest 5. `tests/integration` is its own workspace package (`@actor-kit/integration-tests`). One config (`cloudflareTest()` plugin) runs every file, WebSocket tests included — the old isolated/WebSocket split is gone. Run with `pnpm test:integration`. The config caps parallelism at `maxWorkers: "25%"`: each worker is a whole workerd runtime, and Vitest's default (cores - 1) oversubscribes the CPU, making CPU-bound tests (the 510-message timeline ring-buffer test) about 7x slower and the whole suite slower too.
**Speed**: ~50-200ms per test.
**Location**: `tests/integration/`

```typescript
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("TodoList DO lifecycle", () => {
  it("spawns and returns snapshot via HTTP", async () => {
    const id = env.TODO_LIST.idFromName("test-1");
    const stub = env.TODO_LIST.get(id);

    // Spawn
    await stub.spawn({ creator: "alice" });

    // Get snapshot
    const snapshot = await stub.getSnapshot("alice");
    expect(snapshot.state.todos).toEqual([]);
  });

  it("persists state across DO restarts", async () => {
    const id = env.TODO_LIST.idFromName("test-persist");
    const stub = env.TODO_LIST.get(id);

    await stub.spawn({ creator: "alice" });
    await stub.send("alice", { type: "ADD_TODO", text: "Persist me" });

    // Simulate DO restart by getting a new stub (vitest-pool-workers handles this)
    const stub2 = env.TODO_LIST.get(id);
    const snapshot = await stub2.getSnapshot("alice");
    expect(snapshot.state.todos).toHaveLength(1);
    expect(snapshot.state.todos[0].text).toBe("Persist me");
  });

  it("rejects unauthorized messages", async () => {
    const id = env.TODO_LIST.idFromName("test-auth");
    const stub = env.TODO_LIST.get(id);

    await stub.spawn({ creator: "alice" });

    // "stranger" is viewer role — cannot ADD_TODO
    const result = await stub.send("stranger", { type: "ADD_TODO", text: "Nope" });
    expect(result.error).toBeDefined();

    const snapshot = await stub.getSnapshot("alice");
    expect(snapshot.state.todos).toHaveLength(0);
  });
});
```

### Journal replay (ADR-013)

Every persisted transition is journaled. `replayJournal(contract, journal)` from `@actor-kit/test` folds a journal through the contract's current handlers and throws `JournalDivergenceError` at the first event whose after-state checksum differs (or `JournalNondeterminismError` if a handler reads a fact that wasn't recorded). Read a real DO's journal with `readJournal(state.storage.sql)` inside `runInDurableObject`:

```typescript
const journal = await runInDurableObject(stub, (_i, state) => readJournal(state.storage.sql));
await replayJournal(ChatRoomContract, journal); // throws if any handler used Date.now()/Math.random()
```

`tests/integration/examples-replay.test.ts` runs every example actor this way. Add new example actors there.

### Multi-actor simulations (ADR-015 D4)

`simulate()` (`@actor-kit/test`) runs many actors through the runtime's own step core on a virtual clock: services
wait in `pendingEffects()` until the test resolves or rejects them, forwards are delivered, link views are pushed to
subscribers through `link.onUpdate`, `advance()` fires timers like `alarm()`, ids and randoms are seeded, and
`branch()` copies the whole simulation. Every simulated journal verifies with `replayJournal()`. Use it for
multi-actor and time-dependent logic before reaching for the Workers pool (`tests/unit/simulate-examples.test.ts`
ports the auction and chat-room scenarios; `simulate-link-pushes.test.ts` the Studio lobby link scenario).

### SQL on real SQLite in unit tests

The runtime's SQL lives in pure modules (`runtime/outbox-store.ts`, `timers-store.ts`, `journal.ts`, `migrations.ts`)
that take the structural `JournalSql` slice of `SqlStorage`. Unit tests run them on Node's `node:sqlite` through
`tests/unit/helpers/node-sql.ts`, with every migration applied, so they are fast and covered by Stryker
(`actor.ts`, which imports `cloudflare:workers`, is not).

### Coverage for the Durable Object (CRAP)

`actor.ts` runs only under vitest-pool-workers, so unit coverage alone scores it 0%. `pnpm crap:worker` also runs
the integration suite with `ACTOR_KIT_COVERAGE=1`: `tests/integration/vitest.config.ts` then aliases
`@actor-kit/worker` to its source and collects istanbul coverage inside workerd (v8 coverage is not available
there). `scripts/crap.mts` takes `--coverage` more than once and gives each function its best coverage. Leave
`coverage.include` unset in that config: listing files the tests never load makes Vitest instrument them inside
workerd, which fails after the run ("Unknown Error: undefined").

### Mutation-testing gotchas

- `expect(p).rejects.toThrow("msg")` passes when `p` rejects with `undefined` (Vitest 4). Catch the rejection and
  check it is an `Error` with the message.
- A Stryker run that is killed leaves `.stryker-tmp/sandbox-*` behind, and Playwright then also runs the spec copies
  inside it. Delete `.stryker-tmp` before `pnpm test:e2e`. `--incremental` takes no value (`--incremental false`
  is read as a config file named "false").
- A mutant that makes a module throw while loading (an invalid `z.discriminatedUnion`) is reported as survived by
  Stryker's Vitest runner: prefer constructs that cannot throw at load.

## TDD workflow

Red-green-refactor for every feature:

```
1. Write a failing test (red)
   - Test the behavior you want, not the implementation
   - Use testActor for logic, vitest-pool-workers for infrastructure

2. Implement the minimum code to pass (green)
   - No extra features, no premature optimization
   - If it passes, stop

3. Refactor (refactor)
   - Clean up duplication, improve naming
   - All tests must still pass

4. Repeat
```

## What to test at each level

| Concern | Unit | testActor | Integration |
|---------|------|-----------|-------------|
| Schema encode/decode | x | | |
| Identity helpers | x | | |
| Role evaluation | | x | |
| Message routing | | x | |
| State transitions | | x | |
| View computation | | x | |
| Emission capture | | x | |
| Persistence | | | x |
| WebSocket lifecycle | | | x |
| Binary frame encoding | | | x |
| Reconnection | | | x |
| Outbox drain | | | x |
| DO Alarms | | | x |
| Actor-to-actor RPC | | | x |
| Schema migration | | x | x |

## Fakes over mocks

Never mock internals. Use real implementations or purpose-built fakes:

- **`testActor()`** is a fake runtime — it evaluates roles, routes messages, computes views, captures emissions, but doesn't use CF infrastructure.
- **`vitest-pool-workers`** provides real CF infrastructure — real DOs, real SQLite, real WebSocket.
- **Zod schemas** are real — no mocking validation.

If you need to test a side effect (e.g., Queue.send), use emission capture in `testActor()` or inspect the outbox table in integration tests.

## Naming conventions

```
tests/
├── unit/
│   ├── schema.encode.test.ts
│   ├── schema.decode.test.ts
│   ├── schema.delta.test.ts
│   ├── auth.jwt.test.ts
│   ├── actor.roles.test.ts
│   ├── actor.messages.test.ts
│   ├── actor.views.test.ts
│   └── actor.emissions.test.ts
└── integration/
    ├── lifecycle.spawn.test.ts
    ├── lifecycle.persist.test.ts
    ├── lifecycle.reconnect.test.ts
    ├── websocket.snapshot.test.ts
    ├── websocket.delta.test.ts
    ├── outbox.drain.test.ts
    ├── rpc.actor-to-actor.test.ts
    └── migration.test.ts
```

Pattern: `{module}.{behavior}.test.ts`
