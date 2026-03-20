# 003: First-Class Remote Actor References

**Priority**: P1
**Status**: Proposal
**Affects**: New module `src/fromRemoteActor.ts`, types, exports

## Problem

Actor-to-actor communication currently requires a custom workaround. In Piqolo, a 200+ line `fromActorKit.ts` helper bridges XState callback logic with remote actors:

```typescript
// Current: Custom workaround in piqolo
invoke: {
  id: "profile",
  src: "profile",  // custom callback actor
  input: { server, actorId, actorInput, caller, signingKey, eventSchema },
}

// The "profile" actor source is a manual implementation that:
// 1. Creates an access token
// 2. Opens a WebSocket to the profile Durable Object
// 3. Parses incoming events with Zod
// 4. Applies JSON patches to maintain snapshot
// 5. Emits typed events back to parent
// 6. Handles reconnection
```

Additionally, syncing child actor state into the parent requires verbose boilerplate:

```typescript
// Current: Manual state mapping in piqolo
on: {
  PROFILE_UPDATED: {
    actions: assign(({ context, event }) =>
      produce(context, (draft) => {
        draft.public.profileSnapshot = event.snapshot;
        draft.public.playCanvasData.coins = event.snapshot.public.coins;
        draft.public.playCanvasData.rewardedInteractions = event.snapshot.public.rewardedInteractions;
        // ... more manual mappings
      })
    ),
  },
}
```

And forwarding events to child actors is manual:

```typescript
// Current: Manual event forwarding
const PROFILE_FORWARDED_EVENTS = [
  "TRACK_CONSENT", "RECORD_AR_PERMISSION", "UPDATE_PREFERENCES",
  "SELECT_BUDDY", "MINIGAME_COMPLETED", "PURCHASE_SHOP_ITEM",
];

// In state definition:
always: {
  guard: ({ event }) => PROFILE_FORWARDED_EVENTS.includes(event.type),
  actions: sendTo("profile", ({ event }) => event),
}
```

## Proposed API

### `fromRemoteActor` — XState actor logic for remote actors

```typescript
import { fromRemoteActor } from "@actor-kit/worker"

const playerMachine = setup({
  actors: {
    profile: fromRemoteActor<ProfileMachine>({
      actorType: "profile",
      // How to resolve the actor ID from the parent's context/input
      getActorId: ({ context }) => context.public.profileId,
      // Events from parent to forward to this actor
      forward: ["TRACK_CONSENT", "SELECT_BUDDY", "PURCHASE_SHOP_ITEM"],
    }),
  },
}).createMachine({
  // ...
  invoke: {
    id: "profile",
    src: "profile",
    input: ({ context }) => ({ profileId: context.public.profileId }),
  },
  // No manual PROFILE_UPDATED handler needed —
  // the actor emits snapshot updates automatically
})
```

### What `fromRemoteActor` does internally

1. **Creates an access token** for the remote actor using the parent's signing key
2. **Opens an internal connection** (not WebSocket — direct DO stub call within the same Worker)
3. **Subscribes to snapshot changes** on the remote actor
4. **Emits `REMOTE_SNAPSHOT_UPDATED` events** to the parent with typed snapshot data
5. **Forwards declared events** from parent to child
6. **Handles reconnection** if the remote DO restarts

### Snapshot projection (optional)

Instead of manually mapping child state into parent context:

```typescript
const playerMachine = setup({
  actors: {
    profile: fromRemoteActor<ProfileMachine>({
      actorType: "profile",
      getActorId: ({ context }) => context.public.profileId,
      forward: ["TRACK_CONSENT", "SELECT_BUDDY"],
      // Declare what to project into parent context
      project: {
        path: "public.profileData",
        select: (snapshot) => ({
          coins: snapshot.public.coins,
          inventory: snapshot.public.inventory,
          buddy: snapshot.public.preferences.buddy,
        }),
      },
    }),
  },
})
```

When the remote actor's snapshot changes, `project.select` runs and the result is automatically `assign`ed to `project.path` in the parent's context. No manual `PROFILE_UPDATED` handler needed.

### Direct Durable Object communication (server-to-server)

Since both actors run in the same Cloudflare Worker, we can skip WebSocket and use the Durable Object stub directly:

```typescript
// Internal implementation — not exposed to developer
const stub = env.PROFILE.get(env.PROFILE.idFromName(actorId));
const response = await stub.fetch(new Request("https://internal/api/profile/" + actorId, {
  method: "POST",
  headers: { Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify(event),
}));
```

For real-time updates, use the DO's WebSocket hibernation API internally.

## Implementation

### New files

| File | Purpose |
|------|---------|
| `src/fromRemoteActor.ts` | XState actor logic factory for remote actors |
| `src/remoteActorTypes.ts` | Types for remote actor configuration and events |

### Modified files

| File | Change |
|------|--------|
| `src/types.ts` | Add `RemoteActorConfig`, `RemoteSnapshotEvent` types |
| `src/createMachineServer.ts` | Pass `env` to actor context so `fromRemoteActor` can access DO namespaces |
| `src/index.ts` (worker entry) | Export `fromRemoteActor` |

### `fromRemoteActor` implementation sketch

```typescript
import { fromCallback } from "xstate";

export function fromRemoteActor<TRemoteMachine>(config: {
  actorType: string;
  getActorId: (context: { context: any; input: any }) => string;
  forward?: string[];
  project?: {
    path: string;
    select: (snapshot: CallerSnapshotFrom<TRemoteMachine>) => unknown;
  };
}) {
  return fromCallback(({ sendBack, receive, input }) => {
    const { env, signingKey } = input;
    const actorId = config.getActorId(input);

    // Create access token for inter-actor auth
    const token = createAccessTokenSync(signingKey, actorId, config.actorType);

    // Get DO stub
    const namespace = env[config.actorType.toUpperCase()] as DurableObjectNamespace;
    const stub = namespace.get(namespace.idFromName(actorId));

    // Connect and subscribe to snapshots
    const ws = stub.connect(); // Durable Object WebSocket
    ws.addEventListener("message", (msg) => {
      const data = JSON.parse(msg.data);
      if (data.type === "patch") {
        applyPatch(currentSnapshot, data.operations);
        sendBack({
          type: `${config.actorType.toUpperCase()}_SNAPSHOT_UPDATED`,
          snapshot: currentSnapshot,
        });
      }
    });

    // Forward events from parent to child
    receive((event) => {
      if (config.forward?.includes(event.type)) {
        ws.send(JSON.stringify(event));
      }
    });

    return () => ws.close();
  });
}
```

## Test Plan

### Unit tests (new file: `from-remote-actor.test.ts`)

1. **Creates connection to remote actor**
   - Setup: Mock DO namespace and stub
   - Act: Invoke `fromRemoteActor` logic
   - Assert: `namespace.get()` called with correct ID, WebSocket opened

2. **Emits snapshot updates to parent**
   - Setup: Invoke remote actor
   - Act: Simulate snapshot patch from remote DO
   - Assert: Parent receives `SNAPSHOT_UPDATED` event with correct data

3. **Forwards declared events**
   - Setup: `forward: ["TRACK_CONSENT"]`
   - Act: Parent sends `TRACK_CONSENT` event
   - Assert: Event forwarded to remote DO WebSocket

4. **Does NOT forward undeclared events**
   - Setup: `forward: ["TRACK_CONSENT"]`
   - Act: Parent sends `ADD_TODO` event
   - Assert: Event NOT sent to remote DO

5. **Projection maps snapshot to parent context path**
   - Setup: `project: { path: "public.profileData", select: (s) => s.public.coins }`
   - Act: Remote actor snapshot changes
   - Assert: Parent context at `public.profileData` updated with projected value

6. **Handles remote DO restart**
   - Setup: Invoke remote actor, simulate WebSocket close
   - Assert: Reconnection attempted

7. **Cleans up on parent actor stop**
   - Act: Stop the parent actor
   - Assert: WebSocket to remote actor closed

### Integration tests

8. **Full parent-child lifecycle**
   - Setup: Two machine servers (player + profile)
   - Act: Player invokes profile, sends forwarded event, receives snapshot update
   - Assert: End-to-end state synchronization works

### Mutation testing targets

- Forward event filtering
- Projection `select` function application
- WebSocket lifecycle (connect/close)
- Access token generation
