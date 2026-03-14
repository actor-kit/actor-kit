# 010: Snapshot Projections from Child Actors

**Priority**: P3
**Status**: Proposal
**Affects**: `fromRemoteActor` (003)

## Problem

When a parent actor invokes a child actor, syncing the child's state into the parent requires manual boilerplate:

```typescript
// Current: ~20 lines of manual mapping per child actor
on: {
  PROFILE_UPDATED: {
    actions: assign(({ context, event }) =>
      produce(context, (draft) => {
        draft.public.profileSnapshot = event.snapshot;
        draft.public.playCanvasData.coins = event.snapshot.public.coins;
        draft.public.playCanvasData.rewardedInteractions = event.snapshot.public.rewardedInteractions;
        draft.public.playCanvasData.inventory = event.snapshot.public.inventory;
        // ... more manual mappings
      })
    ),
  },
}
```

## Proposed API

Declarative projections as part of `fromRemoteActor` (003):

```typescript
profile: fromRemoteActor<ProfileMachine>({
  actorType: "profile",
  getActorId: ({ context }) => context.public.profileId,
  project: {
    path: "public.profileData",
    select: (snapshot) => ({
      coins: snapshot.public.coins,
      inventory: snapshot.public.inventory,
      buddy: snapshot.public.preferences.buddy,
    }),
  },
})
```

The `select` function runs whenever the child's snapshot changes. The result is automatically assigned to `path` in the parent's context.

## Implementation

This is part of 003's `fromRemoteActor`. The projection runs inside the callback actor's message handler and emits a typed assign action.

## Test Plan

1. **Projection updates parent context on child change**
2. **Projection only runs when child snapshot actually differs** (checksum comparison)
3. **Type safety**: `select` return type must match the type at `path`
4. **Projection errors don't crash parent actor**
