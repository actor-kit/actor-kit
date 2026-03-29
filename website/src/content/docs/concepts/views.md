---
title: Views
description: Schema-defined views with per-role projections.
---

## What is a View?

A view is a projection of the actor's state for a specific role. Different roles can see different data from the same actor.

```typescript
import { view, schema, uint32, string, array } from "@actor-kit/core";

const OwnerView = schema({ todos: array(TodoItem), memberCount: uint32 });
const ViewerView = schema({ todoCount: uint32, doneCount: uint32 });

views: {
  owner: view(OwnerView, (state) => ({
    todos: state.todos,
    memberCount: state.memberIds.length,
  })),
  viewer: view(ViewerView, (state) => ({
    todoCount: state.todos.length,
    doneCount: state.todos.filter(t => t.done).length,
  })),
},
```

## Schema

`schema()` defines the shape of the view for both TypeScript type inference and binary encoding:

```typescript
const PlayerView = schema({
  x: float32,
  y: float32,
  health: uint32,
  name: string,
  alive: boolean,
});

type PlayerViewType = Infer<typeof PlayerView>;
// { x: number; y: number; health: number; name: string; alive: boolean }
```

### Primitives

| Type | Bytes | TypeScript |
|------|-------|------------|
| `uint8` | 1 | `number` |
| `uint16` | 2 | `number` |
| `uint32` | 4 | `number` |
| `float32` | 4 | `number` |
| `float64` | 8 | `number` |
| `string` | 2 + UTF-8 | `string` |
| `boolean` | 1 | `boolean` |

### Combinators

- `array(T)` — array of any schema type
- Nested `schema({...})` — objects within objects

## Binary Sync

Views defined with `view(schema, fn)` are automatically encoded as compact binary frames with delta encoding — only changed fields are sent. A position update (3 float32 fields) is 15 bytes as a binary delta vs ~100 bytes as JSON.

See [Binary State Sync](/concepts/binary-sync/) for the full wire protocol, frame format, and reconnection details.

## View Computation

Views are computed after every transition. The framework:
1. Calls your view function with the current state and caller
2. Compares with the previous view for this connection
3. If changed: encodes and sends (binary delta or JSON)
4. If unchanged: skips (no frame sent)

This means views are cheap — if nothing changed for a particular caller, nothing is sent.

## Related

- [Binary State Sync](/concepts/binary-sync/) — deep dive into the binary wire protocol, delta encoding, and frame format
