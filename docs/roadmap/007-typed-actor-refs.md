# 007: Typed Actor References

**Priority**: P2
**Status**: Proposal
**Affects**: types, `fromRemoteActor` (003)

## Problem

When sending events between actors, there's no compile-time validation that the event matches the target machine's schema. In Piqolo:

```typescript
// No type error even if ADD_COINS doesn't exist on ProfileMachine
sendTo("profile", { type: "ADD_COINS", amount: 10 })
```

This is caught at runtime by Zod validation, but a type error at compile time would be much better.

## Proposed API

### Typed `sendTo` via actor reference

If using `fromRemoteActor` (003), event forwarding is already typed by the `forward` array. For manual `sendTo`, provide a typed helper:

```typescript
import { createTypedSendTo } from "@actor-kit/types"

// Creates a type-safe sendTo that only accepts events from ProfileMachine
const sendToProfile = createTypedSendTo<ProfileMachine>("profile")

// In machine definition:
actions: sendToProfile({ type: "ADD_COINS", amount: 10 })
// TS error if ADD_COINS is not in ProfileMachine's client/service event union
```

### Type extraction

```typescript
// Already exists:
type ClientEventFrom<TMachine> = /* extracts client events */
type ServiceEventFrom<TMachine> = /* extracts service events */

// New:
type SendableEventTo<TMachine> = ClientEventFrom<TMachine> | ServiceEventFrom<TMachine>
```

## Implementation

This is primarily a types-only change. The runtime behavior is identical to `sendTo` — the type wrapper just constrains the event parameter.

```typescript
// src/types.ts
export function createTypedSendTo<TMachine extends AnyActorKitStateMachine>(
  actorId: string
) {
  return (event: SendableEventTo<TMachine>) => sendTo(actorId, () => event);
}
```

## Test Plan

1. **Compile-time**: TypeScript should reject invalid events (test via `tsc --noEmit` on test fixtures)
2. **Runtime**: `createTypedSendTo` produces a valid XState `sendTo` action
3. **Integration**: Works with `fromRemoteActor` forward declarations
