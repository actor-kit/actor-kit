# XState as Core State Machine Runtime

**Date**: 2026-03-14
**Status**: Accepted (retrospective)
**Deciders**: Jonathan Mumm

## Context

Actor-kit needs a state machine runtime that supports:
- Typed states and transitions
- Guards (conditional transitions)
- Actions (side effects on transition)
- Invoked actors (child processes like timers, API calls)
- Serializable snapshots (for persistence and sync)
- Schema migration (for evolving state over time)

## Decision

Use XState v5 as the core state machine runtime. Actor-kit wraps XState machines in Durable Objects and handles networking, persistence, and synchronization.

### Why

- **Comprehensive**: XState provides states, guards, actions, invoked actors, parallel states, history states — the full statechart specification
- **TypeScript-native**: XState v5 has excellent type inference for events, context, and state values
- **Serializable snapshots**: `actor.getSnapshot()` returns a JSON-serializable object suitable for persistence and network transmission
- **Migration support**: `xstate-migrate` automatically generates migrations when machine definitions change between deployments
- **Ecosystem**: Inspector tools, visualizer, community patterns

### Alternatives considered

- **Custom state machine**: Less maintenance burden but would need to reimplement guards, parallel states, invoked actors, and type inference. Not worth the effort.
- **Zustand/Redux**: Not state machines. No guards, no statechart semantics, no invoked actors.

### Trade-offs

- **Learning curve**: XState's statechart model is powerful but unfamiliar to many developers
- **Bundle size**: XState adds ~15KB gzipped. Acceptable for server-side (DO) usage; browser client doesn't import XState
- **Version coupling**: Actor-kit is tightly coupled to XState v5. Major XState updates require actor-kit updates.

## Consequences

- All actor behavior is defined as XState machines using `setup().createMachine()`
- Machine definitions must follow actor-kit conventions (public/private context, typed events)
- `xstate-migrate` is required for persisted actors that evolve over time
- The `WithActorKitEvent<>` type augments XState events with framework metadata (caller, storage, env)
