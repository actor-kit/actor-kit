---
title: Public & Private Context
description: How Actor Kit separates shared and caller-scoped state.
---

Every Actor Kit machine has two context layers: **public** and **private**. This is the core data model — every machine you build uses this structure.

## The shape

```typescript
type ServerContext = {
  public: PublicContext;           // Shared with all connected clients
  private: Record<string, PrivateContext>;  // Keyed by caller ID
};
```

- **Public context** is visible to every connected client. Use it for shared state like a list of todos, game scores, or room participants.
- **Private context** is a `Record<string, T>` keyed by caller ID. Each caller only sees their own entry. Use it for per-user preferences, access counts, or caller-specific UI state.

## Example

```typescript
export type TodoServerContext = {
  public: {
    ownerId: string;
    todos: Array<{ id: string; text: string; completed: boolean }>;
  };
  private: Record<string, {
    accessCount: number;
    lastViewedAt: number;
  }>;
};
```

In this example, all clients see the same todo list. But each client has their own `accessCount` and `lastViewedAt` that no other client can see.

## What clients receive

Clients never see the full `private` record. Actor Kit creates a **caller-scoped snapshot** for each WebSocket:

```typescript
// What client "user-123" receives:
{
  public: {
    ownerId: "user-456",
    todos: [{ id: "1", text: "Buy milk", completed: false }],
  },
  private: {
    accessCount: 3,        // only user-123's data
    lastViewedAt: 1710000000,
  },
  value: "ready",          // current XState state value
}
```

This is the `CallerSnapshotFrom<TMachine>` type — it's what `useSelector` receives in React components.

## Writing to private context

Use the `caller` property on events to write to the correct private slot:

```typescript
actions: {
  trackAccess: assign({
    private: ({ context, event }) => ({
      ...context.private,
      [event.caller.id]: {
        ...context.private[event.caller.id],
        accessCount: (context.private[event.caller.id]?.accessCount ?? 0) + 1,
        lastViewedAt: Date.now(),
      },
    }),
  }),
},
```

## Security guarantee

The caller-scoping happens inside the Durable Object before any data leaves the server. There's no client-side filtering — the server simply never sends another caller's private data over the wire.

Different callers may receive **different JSON Patch diffs** for the same state transition, because their caller-scoped snapshots differ.
