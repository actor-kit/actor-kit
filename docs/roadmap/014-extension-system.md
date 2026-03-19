# 014: Composable Extension System (`.with()`)

**Priority**: P1
**Status**: Proposal
**Inspired by**: `@xstate/store` v3 `.with()` pattern

## Problem

Actor-kit's server and client capabilities are configured via boolean flags and constructor options. Adding new cross-cutting concerns (persistence strategies, undo/redo, offline support, optimistic updates) means adding more flags and options to already complex factory functions. There's no way for users to compose behaviors or for the community to build extensions.

Current examples of flag-based configuration:

```typescript
// Server: persistence is a boolean flag
createMachineServer({
  machine,
  schemas,
  options: { persisted: true }, // no configuration, no strategy choice
});

// Client: no extension point at all
createActorKitClient({ host, actorType, actorId, accessToken });
```

## Proposed API

Composable `.with(extension())` pattern for both server and client:

```typescript
// Server extensions
const ServerClass = createMachineServer({ machine, schemas })
  .with(persist({ strategy: 'sqlite', throttle: 1000 }))
  .with(eventLog({ maxEvents: 10000 }))
  .with(alarmPersistence({ interval: 30_000 }));

// Client extensions
const client = createActorKitClient(options)
  .with(optimisticUpdates())
  .with(offlineQueue({ maxEvents: 100 }));
```

### Extension Interface

```typescript
interface ActorKitServerExtension<TMachine> {
  name: string;
  onInitialize?(server: ActorServer<TMachine>): void | Promise<void>;
  onEvent?(event: AugmentedEvent, server: ActorServer<TMachine>): void;
  onSnapshotChange?(snapshot: SnapshotFrom<TMachine>, server: ActorServer<TMachine>): void;
  onConnect?(caller: Caller, server: ActorServer<TMachine>): void;
  onDisconnect?(caller: Caller, server: ActorServer<TMachine>): void;
}

interface ActorKitClientExtension<TMachine> {
  name: string;
  onConnect?(client: ActorKitClient<TMachine>): void;
  onDisconnect?(client: ActorKitClient<TMachine>): void;
  onSend?(event: ClientEvent, client: ActorKitClient<TMachine>): ClientEvent | null;
  onSnapshot?(snapshot: CallerSnapshotFrom<TMachine>, client: ActorKitClient<TMachine>): void;
}
```

## Implementation

1. Add `.with()` method to the return types of `createMachineServer` and `createActorKitClient`
2. Extensions stored as an ordered array, called at each lifecycle hook
3. Each `.with()` returns a new wrapper (immutable chaining), preserving type safety
4. Migrate `options.persisted` to `persist()` extension (deprecate flag)

### Key Files

- `src/createMachineServer.ts` — server extension hooks
- `src/createActorKitClient.ts` — client extension hooks
- `src/extensions/` — new directory for built-in extensions
- `src/types.ts` — extension interfaces

## Relationship to Other Proposals

- 001 (Explicit Persistence) → becomes `persist()` extension
- 005 (Alarm Persistence) → becomes `alarmPersistence()` extension
- 006/012 (Event Log / SQLite) → becomes `eventLog()` extension
- 009 (Observability) → becomes `observe()` extension

## Test Plan

1. **Extensions compose without interference** — multiple extensions on same server/client
2. **Extension lifecycle order** — hooks fire in `.with()` registration order
3. **Type preservation** — `.with()` chain preserves TMachine generic
4. **Extension errors don't crash host** — isolated error handling per extension
5. **Backward compatibility** — `options.persisted: true` still works (maps to default `persist()`)
