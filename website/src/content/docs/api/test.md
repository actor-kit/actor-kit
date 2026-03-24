---
title: actor-kit/test
description: Test helper reference.
---

The test export (`import from "actor-kit/test"`) provides a test harness that runs actor transitions without a Cloudflare runtime.

## `testActor(def)`

Creates a test harness for an actor definition.

```typescript
import { testActor } from "actor-kit/test";
import { TodoList } from "./todo";

const t = testActor(TodoList);
```

### `t.init(input)`

Validates input with Zod and returns the initial state.

```typescript
const state = t.init({ creator: "alice" });
// state: { todos: [], ownerId: "alice", memberIds: [] }
```

Throws if input is invalid.

### `t.send(state, caller, event, opts?)`

Resolves the caller's role, validates the message, runs the handler. Returns the new state.

```typescript
let state = t.init({ creator: "alice" });
state = await t.send(state, "alice", { type: "ADD_TODO", text: "Buy milk" });
```

Throws if:
- No role matches the caller
- Message type not found for the role
- Zod validation fails
- Guard returns false

Options: `{ callerType: "service" }` to override the default "user".

### `t.sendWithEffects(state, caller, event, opts?)`

Same as `send()` but also returns captured `emit()` and `request()` calls.

```typescript
const { state, emissions, requests } = await t.sendWithEffects(
  state, "alice", { type: "NOTIFY" }
);

expect(emissions).toHaveLength(1);
expect(emissions[0]).toEqual({ queue: "EMAIL", body: { ... } });
```

### `t.view(state, caller, opts?)`

Resolves the caller's role and returns `{ role, data }`.

```typescript
const view = t.view(state, "alice");
expect(view.role).toBe("owner");
expect(view.data.todos).toHaveLength(1);

const viewerView = t.view(state, "stranger");
expect(viewerView.role).toBe("viewer");
expect(viewerView.data.todoCount).toBe(1);
```

### `t.role(state, caller, opts?)`

Returns the role name or `null`.

```typescript
expect(t.role(state, "alice")).toBe("owner");
expect(t.role(state, "stranger")).toBe("viewer");
expect(t.role(state, "unknown", { callerType: "service" })).toBe("service");
```

## Observability

If the actor definition has `observe.onTransition`, `testActor` fires it after each successful `send()`:

```typescript
const transitions = [];
const def = {
  // ...
  observe: {
    onTransition(prev, next, event, ctx) {
      transitions.push({ prev, next, eventType: event.type });
    },
  },
};
```
