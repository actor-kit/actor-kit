# Library-Agnostic Actor Logic Interface

**Date**: 2026-03-20
**Status**: Proposed
**Deciders**: Jonathan Mumm
**Supersedes**: [2026-03-14-xstate-as-core](./2026-03-14-xstate-as-core.md)

## Context

Actor-kit is tightly coupled to XState v5. Every actor's behavior must be defined as an XState machine, and XState-specific types (`StateMachine`, `SnapshotFrom`, `CallerSnapshotFrom`, `WithActorKitEvent`) are woven through all packages — including client-side code that never runs a machine.

This creates three problems:

1. **Approachability**: Developers who know Redux, @xstate/store, or plain reducers must learn XState's statechart model to use actor-kit. Many use cases (todo lists, counters, forms) don't need hierarchical states, parallel regions, or invoked actors.

2. **Bundle weight**: The `@actor-kit/types` package imports XState types, meaning even client-side code carries XState's type surface. The `public`/`private` context convention forces a specific state shape on all users.

3. **User demand**: Users have asked to use actor-kit with their existing state management libraries.

The core insight is that **actor-kit's value is the actor model infrastructure** — Durable Objects, WebSocket sync, JSON Patch diffing, caller-scoped views, JWT auth — not the state management library. The behavior function (`state + event → next state`) is a simple contract that any event-driven library satisfies.

## Decision

Define an `ActorLogic` interface as the contract between actor-kit and state management libraries. Provide adapter packages for popular libraries. Make all client-side packages library-agnostic.

### The Interface

```typescript
interface ActorLogic<TState, TEvent, TView, TEnv, TInput> {
  // State lifecycle
  create(input: TInput): TState;
  transition(state: TState, event: TEvent & { caller: Caller; env: TEnv }): TState;

  // Caller-scoped projection — what each caller sees over the wire
  getView(state: TState, caller: Caller): TView;

  // Persistence
  serialize(state: TState): unknown;
  restore(serialized: unknown): TState;
  version?: number;
  migrate?(serialized: unknown, version?: number): TState;

  // Lifecycle hooks (optional — return new state)
  onConnect?(state: TState, caller: Caller): TState;
  onDisconnect?(state: TState, caller: Caller): TState;
  onResume?(state: TState): TState;
}

type Caller =
  | { type: "client"; id: string }
  | { type: "service"; id: string };
```

### Key Design Decisions

**`caller` and `env` live on the event, not as a separate context arg.** In the actor model, a message is everything the actor needs to process it — including who sent it. This keeps the signature as a universal `(state, event) → state` reducer and ensures consistency across all adapters.

**`getView` replaces `public`/`private` context.** Instead of forcing `{ public: T, private: Record<string, P> }` as the state shape, the user provides a projection function. This is strictly more powerful — a game actor can show each player their own hand, an admin can see everything, a spectator sees a filtered view.

**System events become lifecycle hooks.** `INITIALIZE`, `CONNECT`, `DISCONNECT`, `RESUME` are no longer events in the user's event union. They're optional hooks on the interface. This keeps domain events clean and makes lifecycle behavior opt-in.

**Migration is the user's responsibility.** Without XState's introspectable machine definition, automatic migration (`xstate-migrate`) isn't possible. Instead, the user provides `version` and `migrate()`. The XState adapter can still use `xstate-migrate` internally.

**Transitions are synchronous.** Side effects are handled via `enqueue` (for adapters that support it, like `@xstate/store`) or in lifecycle hooks. This keeps transitions pure, testable, and deterministic.

### Package Structure

```
@actor-kit/core           ← ActorLogic interface, defineLogic(), createDurableActor()
@actor-kit/xstate-store   ← fromXStateStore(storeDef, opts) → ActorLogic
@actor-kit/xstate         ← fromXStateMachine(machine, opts) → ActorLogic
@actor-kit/redux          ← fromRedux(reducer, opts) → ActorLogic

@actor-kit/browser        ← ActorKitClient<TView, TEvent> (library-agnostic)
@actor-kit/react          ← createActorKitContext<TView, TEvent> (library-agnostic)
@actor-kit/server         ← createAccessToken, createActorFetch (unchanged)
@actor-kit/test           ← mock client, transition helper (updated for new types)
```

Client-side packages (`browser`, `react`) only know about `TView` and `TEvent` — they don't know or care whether the server uses XState, Redux, or a plain reducer. The wire protocol (JSON Patch diffs of `TView`) is unchanged.

### Alternatives Considered

**Wrap @xstate/store as the default.** We considered making `defineActor` a thin wrapper around `@xstate/store`. Rejected because it creates an implicit dependency and `@xstate/store`'s transition signature `(context, event, enqueue)` doesn't natively support `caller`/`env` as a concept.

**Effector adapter.** Effector's model (reactive graph of stores subscribing to events) is fundamentally different from the actor model (single state + transition function). Stores are global singletons, making per-DO isolation difficult. Not a good fit.

**Keep XState but make it optional.** This half-measure would mean maintaining XState-specific types alongside generic ones. The full separation is cleaner.

### Trade-offs

- **Lost**: Automatic migration via `xstate-migrate` (for non-XState users)
- **Lost**: XState's statechart visualization tools (for non-XState users)
- **Gained**: Any event-driven state library works
- **Gained**: Simpler client-side types (no `CallerSnapshotFrom` inference chain)
- **Gained**: Users control their state shape (no forced `public`/`private` convention)
- **Gained**: Smaller type surface for client packages

## Consequences

- The `actor-kit` package (types-only) is replaced by `@actor-kit/core`
- `CallerSnapshotFrom`, `WithActorKitEvent`, `BaseActorKitEvent`, `ActorKitStateMachine` types are removed
- Client packages parameterized on `<TView, TEvent>` instead of `<TMachine>`
- Existing XState users migrate to `fromXStateMachine()` adapter with minimal changes
- New users can start with `defineLogic()` or their preferred library's adapter
- `@actor-kit/worker` is absorbed into `@actor-kit/core` (createDurableActor replaces createMachineServer)
