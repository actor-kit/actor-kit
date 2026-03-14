# Public/Private Context Separation

**Date**: 2026-03-14
**Status**: Accepted (retrospective)
**Deciders**: Jonathan Mumm

## Context

Multi-user actors (e.g., a game lobby) need to share some state with all participants while keeping other state private to each user. For example, in a trivia game, the current question is public, but each player's submitted answer should be private until scoring.

## Decision

Every actor's context is split into two top-level fields:

```typescript
type Context = {
  public: Record<string, unknown>;         // Shared with ALL connected callers
  private: Record<string, unknown>;        // Keyed by caller.id, each caller sees only their own
}
```

When creating a caller-scoped snapshot, the server:
1. Includes `context.public` in full
2. Includes only `context.private[caller.id]` (not other callers' private data)
3. Includes `value` (XState state)

### Why

- **Data isolation by default**: Private data cannot leak to other callers — the framework enforces this, not the developer
- **Simple mental model**: Two buckets. Public = everyone sees. Private = only you see.
- **Type-safe**: `CallerSnapshotFrom<TMachine>` correctly types the per-caller view

### Alternatives considered

- **Single flat context with manual filtering**: Error-prone. Developers would need to remember to strip private fields before sending.
- **Separate actor per user**: Expensive. One Durable Object per user × per entity doesn't scale for shared state like game lobbies.

## Consequences

- Machine actions must use `context.public` and `context.private` paths explicitly
- Guards can access the full context (including all private data) server-side
- Client events are augmented with `caller.id` so actions know which private bucket to update
- Empty private context is `Record<string, never>` (common for simple actors like todos)
