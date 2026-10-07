---
title: "@actor-kit/studio"
description: Studio package API reference.
---

The studio package (`@actor-kit/studio`) provides introspection and debugging tools for actor-kit applications.

## `actorKitStudio(request, env, ctx)`

Middleware function that intercepts `/__studio/*` routes. Returns a `Response` if the request matches, or `null` to pass through to your normal routing.

```typescript
import { actorKitStudio } from "@actor-kit/studio";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const studio = actorKitStudio(request, env, ctx);
    if (studio) return studio;
    // ... normal routing
  },
};
```

### Auth behavior

| Condition | Result |
|-----------|--------|
| Localhost, no secret configured | Allowed |
| Remote, no secret configured | 403 |
| Remote, wrong `X-Actor-Kit-Studio-Key` | 401 |
| Remote, correct `X-Actor-Kit-Studio-Key` | Allowed |

## `StudioRegistry`

A Durable Object class that maintains an index of all actor instances. Export it from your Worker:

```typescript
import { StudioRegistry } from "@actor-kit/studio";
export { StudioRegistry };
```

Actors auto-register with the registry when they detect it in `ctx.exports`. The registry provides:

### `touch(actorType, actorId, version, previousActorId?, doId?)`

Called by actors (fire-and-forget) to register or update their `last_active_at`. Debounced at 10 seconds per actor instance. When an actor auto-spawned under its hex DO ID is later named by `spawn({ actorId })`, it passes the hex ID as `previousActorId` and the row is re-keyed, so the actor is listed once, under its name. `doId` records the DO hex ID so the Studio can still find the actor by it.

### `updateConnections(actorType, actorId, count)`

Called by actors when WebSocket connections change, and on every cold start. The count is the number of app sockets the actor holds, so it stays exact across hibernation and restarts.

### `listActors(opts)`

Returns actors sorted by most recent activity.

```typescript
interface ListOptions {
  type?: string;    // Filter by actor type
  search?: string;  // Search actor IDs (LIKE match)
  limit?: number;   // Default: 50
  offset?: number;  // For pagination
}
```

### `getActorTypes()`

Returns distinct actor type names.

## Actor RPC methods

Every actor created with `actor()` or `createActorClass()` exposes these RPC methods:

### `__inspect()`

Returns a snapshot of the actor's current state and metadata.

```typescript
const result = await stub.__inspect();
```

Returns:

```typescript
{
  state: unknown;              // Current actor state
  version: number;             // Actor version
  actorId: string | null;      // Human-readable actor ID
  connections: Array<{         // Active WebSocket connections
    caller: string;
    callerType: "user" | "service";
  }>;
  outbox: Array<{              // Service executions
    id: string;
    service: string;
    payload: string;
    status: string;            // "pending" | "done" | "failed"
    attempts: number;
    createdAt: number;
  }>;
  activeLinks: Array<{         // Actor-to-actor links (subscriber side)
    targetType: string;
    targetId: string;
    linkName: string;
    version: number;
  }>;
  linkSubscribers: Array<{     // DO subscribers (source side)
    subscriberType: string;
    subscriberId: string;
  }>;
}
```

### `__getTimeline(opts?)`

Returns paginated timeline entries, newest first.

```typescript
const result = await stub.__getTimeline({ limit: 20 });
const page2 = await stub.__getTimeline({ limit: 20, before: lastId });
```

Returns:

```typescript
{
  entries: Array<{
    id: number;              // Auto-incrementing ID (cursor for pagination)
    causeType: string;       // "init" | "message" | "service.onDone" | etc.
    causeData: string;       // JSON-serialized cause details
    stateSnapshot: string;   // Full state as JSON after mutation
    checksum: string;        // State hash
    createdAt: number;       // Timestamp
  }>;
  hasMore: boolean;
}
```

## Studio WebSocket protocol

Connect to an actor's studio WebSocket to receive live updates:

```
ws://host/__studio/actors/:type/:id/ws
```

The studio WebSocket bypasses role evaluation. It uses the reserved caller ID `__studio`.

### Messages from server

**`studio.snapshot`** — sent immediately on connect:

```typescript
{
  type: "studio.snapshot";
  state: unknown;
  timeline: TimelineEntry[];
  connections: ConnectionInfo[];
  outbox: OutboxEntry[];
  activeLinks: LinkInfo[];
  linkSubscribers: SubscriberInfo[];
  actorType: string;
  actorId: string;
  version: number;
}
```

**`studio.timeline`** — pushed on every state mutation:

```typescript
{
  type: "studio.timeline";
  entry: {
    id: number;          // same id as the snapshot and __getTimeline()
    causeType: string;
    causeData: string;
    stateSnapshot: string;
    checksum: string;
    createdAt: number;
  };
}
```

**`studio.connection`** — pushed when a client connects or disconnects:

```typescript
{
  type: "studio.connection";
  action: "connect" | "disconnect";
  // connect: { connectionId, caller, callerType, connectedAt, role }
  // disconnect: { connectionId, caller, callerType }
  connection: { connectionId: string; caller: string; callerType: "user" | "service" };
}
```

`connectionId` is unique per socket: two tabs of one caller are two connections.

**`studio.outbox`** — pushed when an execution is added or settles, with the whole outbox (newest first):

```typescript
{
  type: "studio.outbox";
  outbox: Array<{ id: string; service: string; payload: string; status: string; attempts: number; createdAt: number }>;
}
```

**`studio.links`** — pushed when this actor links or unlinks, a subscriber registers or leaves, or a link delivery bumps a version:

```typescript
{
  type: "studio.links";
  activeLinks: Array<{ targetType: string; targetId: string; linkName: string; version: number }>;
  linkSubscribers: Array<{ subscriberType: string; subscriberId: string }>;
}
```

### Messages from client

**`studio.requestView`** — request a computed view for a specific role:

```typescript
ws.send(JSON.stringify({
  type: "studio.requestView",
  role: "user",
  caller: "optional-caller-id", // for perCaller views
}));
```

Response:

```typescript
{
  type: "studio.view";
  role: string;
  caller: string | null;
  data: unknown;
}
```

## `MutationCause` type

Exported from `@actor-kit/core`. Discriminated union of all possible mutation causes:

```typescript
type MutationCause =
  | { type: "init" }
  | { type: "migrate"; fromVersion: number; toVersion: number }
  | { type: "message"; messageType: string; caller: string;
      callerType: "user" | "service"; role: string; payload: unknown }
  | { type: "lifecycle.connect"; caller: string;
      callerType: "user" | "service"; role: string }
  | { type: "lifecycle.disconnect"; caller: string;
      callerType: "user" | "service"; role: string }
  | { type: "service.onDone"; service: string;
      input: unknown; result: unknown }
  | { type: "service.onError"; service: string;
      input: unknown; error: string }
  | { type: "link.onUpdate"; sourceType: string;
      sourceId: string; viewData: unknown }
  | { type: "link.onError"; sourceType: string;
      sourceId: string; error: string }
  | { type: "link.onUnlink"; sourceType: string;
      sourceId: string }
```

## `TimelineEntry` type

Exported from `@actor-kit/core`:

```typescript
interface TimelineEntry {
  readonly cause: MutationCause;
  readonly stateSnapshot: unknown;
  readonly checksum: string;
  readonly createdAt: number;
}
```
