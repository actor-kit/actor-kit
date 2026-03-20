---
title: Caller Types
description: The three caller types that can send events to an actor.
---

Actor Kit categorizes event senders into three **caller types**. Every event that reaches your XState machine is augmented with a `caller` property identifying who sent it.

## The three types

### Client

Browser users connected via WebSocket. Their events are validated against the `clientEvent` Zod schema.

```typescript
// What the client sends:
{ type: "ADD_TODO", text: "Buy milk" }

// What the machine receives:
{
  type: "ADD_TODO",
  text: "Buy milk",
  caller: { type: "client", id: "user-123" },
  // plus: storage, env, requestInfo
}
```

### Service

Backend services that send events via HTTP. Their events are validated against the `serviceEvent` schema. Use this for server-to-server communication, webhooks, or cron jobs.

```typescript
// Service event:
{
  type: "SYNC_TODOS",
  todos: [...],
  caller: { type: "service", id: "sync-worker" },
}
```

### System

Framework-generated events. You never send these — Actor Kit creates them automatically:

| Event | When |
|-------|------|
| `INITIALIZE` | Actor is created for the first time |
| `CONNECT` | A client WebSocket connects |
| `DISCONNECT` | A client WebSocket disconnects |
| `RESUME` | Actor resumes from persisted state (DO restart) |
| `MIGRATE` | State schema has changed, migration needed |

System events include a `caller.type` of `"system"`. `CONNECT` and `DISCONNECT` also include a `clientId` so you can track which specific client connected or disconnected.

## Using caller in guards

The `caller` property enables access control in your machine:

```typescript
guards: {
  isOwner: ({ context, event }) =>
    event.caller.id === context.public.ownerId,
  isService: ({ event }) =>
    event.caller.type === "service",
},
// ...
states: {
  ready: {
    on: {
      DELETE_TODO: {
        guard: "isOwner",
        actions: "deleteTodo",
      },
      SYNC_TODOS: {
        guard: "isService",
        actions: "syncTodos",
      },
    },
  },
},
```

## Event augmentation

Before events reach your machine, Actor Kit augments them with additional context:

```typescript
type AugmentedEvent = YourEvent & {
  caller: { type: "client" | "service" | "system"; id: string };
  storage: DurableObjectStorage;   // DO storage API
  env: YourEnv;                    // Worker env bindings
  requestInfo?: { ip: string };    // Request metadata
};
```

This means your actions and guards have access to storage, environment variables, and the caller's identity without passing them through your machine context.
