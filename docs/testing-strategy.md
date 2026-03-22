# Testing Strategy

## Testing trophy

Following Kent C. Dodds' testing trophy: more integration tests, fewer unit tests. Confidence over coverage.

```
          ╱╲
         ╱  ╲        E2E (Playwright — future, not Phase 1)
        ╱────╲
       ╱      ╲      Integration (vitest-pool-workers: real DO, real WS, real SQLite)
      ╱────────╲
     ╱          ╲    Integration (testActor: transitions + roles + views, no CF runtime)
    ╱────────────╲
   ╱              ╲   Unit (schema encoder/decoder, auth, pure helpers)
  ╱────────────────╲
```

## Test levels

### Level 1: Unit tests (pure functions)

**What**: Schema encoder/decoder, JWT helpers, role evaluation, individual message handlers.
**How**: Plain Vitest. No CF runtime, no network.
**Speed**: < 1ms per test.
**Location**: `tests/unit/`

```typescript
import { describe, it, expect } from "vitest";
import { schema, uint32, string, encode, decode } from "actor-kit";

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
**How**: `testActor()` from `actor-kit/test`. Runs init, send, view in-process.
**Speed**: < 5ms per test.
**Location**: `tests/unit/` (they're still unit tests — no external deps)

```typescript
import { describe, it, expect } from "vitest";
import { testActor } from "actor-kit/test";
import { TodoList } from "../../packages/actor-kit/src/examples/todo";

describe("TodoList actor", () => {
  const t = testActor(TodoList);

  it("initializes with empty todos", () => {
    const state = t.init({ creator: "alice" });
    expect(state.todos).toEqual([]);
    expect(state.ownerId).toBe("alice");
  });

  it("owner can add todo", () => {
    const state = t.init({ creator: "alice" });
    const next = t.send(state, "alice", { type: "ADD_TODO", text: "Buy milk" });
    expect(next.todos).toHaveLength(1);
    expect(next.todos[0].text).toBe("Buy milk");
  });

  it("resolves owner role for creator", () => {
    const state = t.init({ creator: "alice" });
    expect(t.role(state, "alice")).toBe("owner");
  });

  it("resolves viewer role for unknown caller", () => {
    const state = t.init({ creator: "alice" });
    expect(t.role(state, "stranger")).toBe("viewer");
  });

  it("rejects messages not in caller's role", () => {
    const state = t.init({ creator: "alice" });
    expect(() => {
      t.send(state, "stranger", { type: "ADD_TODO", text: "Nope" });
    }).toThrow(); // "stranger" is "viewer", viewer has no ADD_TODO
  });

  it("owner view includes todos", () => {
    let state = t.init({ creator: "alice" });
    state = t.send(state, "alice", { type: "ADD_TODO", text: "Buy milk" });
    const view = t.view(state, "alice");
    expect(view.role).toBe("owner");
    expect(view.todos).toHaveLength(1);
  });

  it("viewer view includes counts, not todos", () => {
    let state = t.init({ creator: "alice" });
    state = t.send(state, "alice", { type: "ADD_TODO", text: "Buy milk" });
    const view = t.view(state, "stranger");
    expect(view.role).toBe("viewer");
    expect(view.todoCount).toBe(1);
    expect(view).not.toHaveProperty("todos");
  });

  it("captures emissions from emit()", () => {
    let state = t.init({ creator: "alice" });
    const { state: next, emissions } = t.sendWithEffects(
      state, "alice", { type: "NOTIFY_ALL" }
    );
    expect(emissions).toHaveLength(1);
    expect(emissions[0].type).toBe("queue");
  });
});
```

### Level 3: Integration tests (vitest-pool-workers)

**What**: Full DO lifecycle — WebSocket connection, binary frames, persistence, reconnection, outbox drain.
**How**: `@cloudflare/vitest-pool-workers`. Real Durable Objects, real SQLite, real WebSocket.
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
| Schema encode/decode | ✓ | | |
| JWT creation/validation | ✓ | | |
| Role evaluation | | ✓ | |
| Message routing | | ✓ | |
| State transitions | | ✓ | |
| View computation | | ✓ | |
| Emission capture | | ✓ | |
| Persistence | | | ✓ |
| WebSocket lifecycle | | | ✓ |
| Binary frame encoding | | | ✓ |
| Reconnection | | | ✓ |
| Outbox drain | | | ✓ |
| DO Alarms | | | ✓ |
| Actor-to-actor RPC | | | ✓ |
| Schema migration | | ✓ | ✓ |

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
