# Actor Kit v2 — Design Document

**Status**: Design complete, ready for implementation
**Breaking change**: Yes — new major version, no backwards compatibility

## Vision

Actors on the edge. Each actor is a Cloudflare Durable Object with a mailbox, private state, and behavior you define. Binary state sync with per-client views. Built from the ground up for Cloudflare infrastructure.

## Key Decisions

### 1. Single API: `actor()`

One function defines an actor. No `defineLogic` + `createDurableActor` two-step.

```typescript
export const Counter = actor("counter", {
  init, roles, messages, views, on,
});
```

### 2. Schema-defined views with `schema()` builder

Views are defined via schemas for binary encoding. No decorators, no classes.
TypeScript types are inferred from the schema — no manual type definitions.

```typescript
const CounterView = schema({
  count: uint32,
  lastUpdatedBy: string,
});

// TypeScript infers: { count: number, lastUpdatedBy: string }
```

### 3. Role-based access control

Roles replace `caller.type` ("client" | "service"). Roles are derived from state — the actor decides who has what role. Both event schemas and views are scoped per role.

```typescript
roles: {
  owner: (state, caller) => caller === state.ownerId,
  member: (state, caller) => state.memberIds.includes(caller),
  guest: () => true, // catch-all last
},
```

- First match wins (top-to-bottom evaluation)
- No match = connection rejected (403)
- Caller is a plain string (just identity from JWT)
- Role re-evaluated on every message

### 4. Per-role event schemas

Events are validated per role BEFORE reaching the transition. Authorization is declarative, not coded in every handler.

```typescript
messages: {
  owner: {
    DELETE: (state, { id }) => produce(state, d => { ... }),
  },
  member: {
    ADD_TODO: (state, { text }) => produce(state, d => { ... }),
  },
  guest: {},  // read-only
},
```

### 5. Per-role views (auto-inferred union)

Each role has a view function. The framework injects a `role` discriminant and builds the TypeScript union automatically.

```typescript
views: {
  owner: view(OwnerView, (state) => ({ todos: state.todos, settings: state.settings })),
  member: view(MemberView, (state) => ({ todos: state.todos })),
  guest: view(GuestView, (state) => ({ todoCount: state.todos.length })),
},

// Inferred: TView =
//   | { role: "owner"; todos: Todo[]; settings: Settings }
//   | { role: "member"; todos: Todo[] }
//   | { role: "guest"; todoCount: number }
```

### 6. Binary wire protocol

Schema-aware binary delta encoding replaces JSON Patch. The framework tracks changes at the field level and encodes only modified fields in binary.

- Position update: ~6 bytes (vs ~52 bytes JSON Patch)
- Full state of 100 entities: ~2.5KB (vs ~30KB JSON)
- Change tracking built into schema instances (no diffing)

### 7. Impure transitions

Transitions can be async and do side effects. DOs are single-threaded and crash-safe. No separate effect system needed.

```typescript
ADD_TODO: async (state, { text }, { env }) => {
  await env.ANALYTICS_QUEUE.send({ event: "todo_added" });
  return produce(state, d => { d.todos.push({ text, done: false }) });
},
```

### 8. Deep Cloudflare integration

| CF Feature | Actor Kit Usage |
|------------|----------------|
| DO Alarms | `after: { "5 minutes": handler }` — timers that survive restarts |
| DO SQLite | CDC history, state queries, event audit log |
| DO RPC | Actor-to-actor communication (replaces WebSocket-based fromActorKit) |
| DO Hibernation | Automatic — framework manages hibernate/wake cycle |
| R2 | Static asset storage (map tiles, game data) |
| Queues | Fire-and-forget side effects with guaranteed delivery |
| Workers AI | AI as a transition (`invoke` with AI binding) |

### 9. Optional finite states

Most actors don't need state machines. When they do, add a `states` key:

```typescript
states: {
  idle: {
    messages: { ... },
    after: { "30 seconds": "active" },
  },
  active: {
    messages: { ... },
    invoke: async (state, { env }) => { ... },  // async on state entry
  },
},
```

States constrain which messages are valid. `after` maps to DO Alarms. `invoke` runs async work on state entry.

### 10. Caller is a string

```typescript
// JWT: { sub: "user-123", jti: "todo-456", aud: "todo" }
// caller = "user-123"
// role = computed from state
```

No `caller.type`. No `{ id, type }` object. Just the identity. The actor's roles determine authorization.

### 11. Event augmentation

When a message arrives, the transition receives:

```typescript
event.caller  // "user-123" (string)
event.role    // "owner" (computed by framework)
event.env     // CF Worker env bindings
```

### 12. Persistence

Always on. Snapshots via `schema.serialize()` to DO SQLite. Version-based migration. Optional CDC (change history stored alongside snapshots).

### 13. `output()` escape hatch

For cases where schema-based sync isn't enough (MMO binary position streaming), `output()` gives full control over the wire:

```typescript
output: (state, caller, role, send) => {
  send.binary(packPositions(nearby));  // raw binary
  send.json({ weather: state.weather }); // structured data
},
```

This bypasses the schema sync for callers that need it. Most actors use `views` (schema sync). MMOs use `output` for the hot path.

## Full Example: Todo List

```typescript
import { actor, schema, view, uint32, string, boolean, array } from "actor-kit";
import { z } from "zod";
import { produce } from "immer";

const TodoItem = schema({
  id: string,
  text: string,
  done: boolean,
});

const OwnerView = schema({
  todos: array(TodoItem),
  memberCount: uint32,
});

const ViewerView = schema({
  todoCount: uint32,
  doneCount: uint32,
});

export const TodoList = actor("todo-list", {
  init: (input) => ({
    todos: [],
    ownerId: input.creator,
    memberIds: [],
  }),

  roles: {
    owner: (state, caller) => caller === state.ownerId,
    member: (state, caller) => state.memberIds.includes(caller),
    viewer: () => true,
  },

  messages: {
    owner: {
      ADD_TODO: (state, { text }) =>
        produce(state, d => {
          d.todos.push({ id: crypto.randomUUID(), text, done: false });
        }),
      DELETE_TODO: (state, { id }) =>
        produce(state, d => {
          d.todos = d.todos.filter(t => t.id !== id);
        }),
      INVITE: (state, { userId }) =>
        produce(state, d => { d.memberIds.push(userId) }),
    },
    member: {
      ADD_TODO: (state, { text }) =>
        produce(state, d => {
          d.todos.push({ id: crypto.randomUUID(), text, done: false });
        }),
      TOGGLE: (state, { id }) =>
        produce(state, d => {
          const todo = d.todos.find(t => t.id === id);
          if (todo) todo.done = !todo.done;
        }),
    },
    viewer: {},
  },

  views: {
    owner: view(OwnerView, (state) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    })),
    member: view(OwnerView, (state) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    })),
    viewer: view(ViewerView, (state) => ({
      todoCount: state.todos.length,
      doneCount: state.todos.filter(t => t.done).length,
    })),
  },

  on: {
    connect: (state, caller) => state,
    disconnect: (state, caller) => state,
  },
});
```

## Full Example: MMO Zone

```typescript
import { actor, schema, view, uint8, uint32, float32, string, array, map } from "actor-kit";
import { produce } from "immer";

const EntityView = schema({
  id: uint32,
  x: float32,
  y: float32,
  z: float32,
  rotation: float32,
  health: uint32,
  maxHealth: uint32,
  level: uint8,
  name: string,
  entityType: uint8,
});

const PlayerZoneView = schema({
  nearby: array(EntityView),
  weather: string,
});

const SpectatorView = schema({
  playerCount: uint32,
  zoneName: string,
});

export const Zone = actor("zone", {
  init: (input) => ({
    name: input.zoneName,
    entities: {},
    positions: {},
    health: {},
    spatialGrid: new SpatialGrid(500, 500, 25),
    weather: "clear",
  }),

  roles: {
    gm: (state, caller) => caller.startsWith("gm-"),
    player: (state, caller) => caller in state.positions,
    spectator: () => true,
  },

  messages: {
    gm: {
      SET_WEATHER: (state, { weather }) =>
        produce(state, d => { d.weather = weather }),
      SPAWN: (state, { id, template, pos }) =>
        produce(state, d => {
          d.entities[id] = template;
          d.positions[id] = pos;
          d.spatialGrid.insert(id, pos);
        }),
    },
    player: {
      MOVE: (state, { x, y, z, rotation }, { caller }) =>
        produce(state, d => {
          d.positions[caller] = { x, y, z };
          d.spatialGrid.update(caller, { x, y, z });
        }),
      ATTACK: (state, { targetId }, { caller }) =>
        produce(state, d => {
          const target = d.health[targetId];
          if (!target) return;
          target.current = Math.max(0, target.current - 10);
        }),
    },
    spectator: {},
  },

  views: {
    gm: view(PlayerZoneView, (state, caller) => ({
      nearby: Object.keys(state.positions).map(id => ({
        id: hashId(id),
        x: state.positions[id].x,
        y: state.positions[id].y,
        z: state.positions[id].z,
        rotation: 0,
        health: state.health[id]?.current ?? 0,
        maxHealth: state.health[id]?.max ?? 0,
        level: 0,
        name: state.entities[id]?.name ?? "",
        entityType: 0,
      })),
      weather: state.weather,
    })),
    player: view(PlayerZoneView, (state, caller) => ({
      nearby: state.spatialGrid.query(state.positions[caller], 120).map(id => ({
        id: hashId(id),
        x: state.positions[id].x,
        y: state.positions[id].y,
        z: state.positions[id].z,
        rotation: 0,
        health: state.health[id]?.current ?? 0,
        maxHealth: state.health[id]?.max ?? 0,
        level: 0,
        name: state.entities[id]?.name ?? "",
        entityType: 0,
      })),
      weather: state.weather,
    })),
    spectator: view(SpectatorView, (state) => ({
      playerCount: Object.keys(state.positions).length,
      zoneName: state.name,
    })),
  },

  on: {
    connect: (state, caller) =>
      produce(state, d => {
        d.positions[caller] = { x: 0, y: 0, z: 0 };
        d.health[caller] = { current: 100, max: 100 };
        d.entities[caller] = { name: caller, type: "player" };
        d.spatialGrid.insert(caller, { x: 0, y: 0, z: 0 });
      }),
    disconnect: (state, caller) =>
      produce(state, d => {
        d.spatialGrid.remove(caller);
        delete d.positions[caller];
        delete d.health[caller];
        delete d.entities[caller];
      }),
    tick: {
      frequency: 100,
      handler: (state) =>
        produce(state, d => {
          // mob AI, respawn timers, etc
        }),
    },
  },
});
```

## Client API

```typescript
import { connect } from "actor-kit/client";

// Connect to an actor
const todo = await connect("todo-list", {
  host: "example.com",
  actorId: "my-list",
  accessToken: jwt,
});

// View is auto-decoded from binary schema
todo.subscribe((view) => {
  if (view.role === "owner") {
    renderOwnerUI(view.todos, view.memberCount);
  }
});

// Send messages (typed to your role's allowed messages)
todo.send({ type: "ADD_TODO", text: "Buy milk" });

// Trigger shorthand
todo.trigger.ADD_TODO({ text: "Buy milk" });

// Disconnect
todo.disconnect();
```

## React API

```typescript
import { createContext } from "actor-kit/react";

const TodoContext = createContext("todo-list");

function App() {
  return (
    <TodoContext.Provider actorId="my-list" host="example.com" accessToken={jwt}>
      <TodoList />
    </TodoContext.Provider>
  );
}

function TodoList() {
  const view = TodoContext.useView();
  const send = TodoContext.useSend();
  const role = TodoContext.useRole();  // "owner" | "member" | "viewer"

  return (
    <div>
      {view.role === "owner" && <button onClick={() => send({ type: "INVITE", userId: "bob" })}>Invite</button>}
      {view.role !== "viewer" && view.todos.map(todo => <TodoItem key={todo.id} todo={todo} />)}
      {view.role === "viewer" && <p>{view.todoCount} todos</p>}
    </div>
  );
}
```

## Implementation Phases

### Phase 1: Core runtime
- `actor()` function
- `schema()` builder with type inference
- `view()` helper
- Role evaluation
- Message routing + validation
- DO class generation
- Snapshot persistence to SQLite

### Phase 2: Binary sync
- Schema-aware binary encoder/decoder
- Change tracking (ChangeTree)
- Binary WebSocket frames
- Client decoder

### Phase 3: Client SDK
- `connect()` function
- Binary decoder
- Subscribe / send / trigger
- Reconnection with binary delta

### Phase 4: React SDK
- `createContext()`
- `useView()` / `useSend()` / `useRole()`
- SSR support

### Phase 5: CF integration
- DO Alarms for `after` / `tick`
- DO RPC for actor-to-actor
- SQLite CDC
- Queue integration

### Phase 6: Advanced
- Finite states
- `invoke` for async state entry
- `output()` escape hatch
- Supervision (actor crash awareness)
