---
title: "@actor-kit/test"
description: Test helper reference.
---

The test package (`@actor-kit/test`) provides a test harness that runs actor transitions without a Cloudflare runtime.

## `testActor(contract)` / `testActor(def)`

Creates a test harness for an actor. Accepts either a contract (from `defineActor()`) or a raw definition object.

### Contract-derived (recommended)

Types for `init()`, `send()`, `view()`, and `role()` are all inferred from the contract:

```typescript
import { testActor } from "@actor-kit/test";
import { CounterContract } from "./counter";

const t = testActor(CounterContract);
```

### `t.init(input)`

Validates input with Zod and returns the initial state.

```typescript
const state = t.init({});
// state: { count: 0, lastUpdatedBy: null }
```

Throws if input is invalid.

### `t.send(state, caller, event, opts?)`

Resolves the caller's role, validates the message, runs the handler. Returns the new state.

```typescript
let state = t.init({});
state = t.send(state, "alice", { type: "INCREMENT" });
```

Throws if:
- No role matches the caller
- Zod validation fails
- Guard returns false

Options: `{ callerType: "service" }` to override the default "user".

### `t.sendWithEffects(state, caller, event, opts?)`

Same as `send()` but also returns captured `emit()` calls.

```typescript
const { state, emissions } = t.sendWithEffects(
  state, "alice", { type: "NOTIFY" }
);

expect(emissions).toHaveLength(1);
expect(emissions[0]).toEqual({ queue: "EMAIL", body: { ... } });
```

### `t.view(state, caller, opts?)`

Resolves the caller's role and returns `{ role, data }`.

```typescript
const view = t.view(state, "alice");
expect(view.role).toBe("user");
expect(view.data.count).toBe(0);
```

### `t.role(state, caller, opts?)`

Returns the role name or `null`.

```typescript
expect(t.role(state, "alice")).toBe("user");
expect(t.role(state, "admin", { callerType: "service" })).toBe("admin");
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
