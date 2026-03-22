# ADR 003: Transactional Outbox for Side Effects

**Date**: 2026-03-22
**Status**: Accepted

## Context

Transitions can trigger side effects (send email, enqueue job, call external API). If the DO crashes after executing the side effect but before persisting state, the side effect runs again on restart — causing duplicates.

Options considered:
1. **Idempotency keys only** — push dedup to the receiver. Simple but requires every downstream to support idempotency.
2. **Persist-then-effect** — record intent in state, execute later. Works but is clunky to use (two transitions per side effect).
3. **Transactional outbox** — write state + side effect intent atomically to SQLite, drain outbox asynchronously.

## Decision

Option 3: transactional outbox via `emit()`.

### API

```typescript
NOTIFY_ALL: (state, _payload, { emit }) => {
  emit("queue", { queue: "EMAIL_QUEUE", body: { to: state.memberIds } });
  return state; // pure state transition
},
```

`emit()` does not execute the side effect. It records the intent. After the transition, the framework writes state + emissions in a single SQLite transaction.

### Drain process

```
1. Transaction commits (state + outbox entries)
2. Schedule async drain
3. For each pending entry:
   a. Execute side effect
   b. On success: mark as 'sent'
   c. On failure: increment attempts
   d. If attempts >= 3: move to emission_failures, deliver EMISSION_FAILED system event
   e. Else: retry with exponential backoff (1s, 5s, 25s)
4. On DO restart: drain immediately (pending items from before crash)
```

### Guarantees

- **At-least-once delivery**: if the DO crashes after commit but before drain, the outbox persists and drains on restart.
- **No lost emissions**: state and emissions are in the same transaction. You can't have state without emissions or emissions without state.
- **Idempotency still needed**: at-least-once means possible duplicates. Each emission gets a UUID for downstream dedup.

## Consequences

- Side effects via `emit()` are guaranteed to be attempted if and only if the state persisted.
- Async transitions are still allowed for effects that inform the next state (e.g., fetch → use response in state). `emit()` is for fire-and-forget.
- The outbox table adds SQLite overhead (~1 INSERT per emission per transition). Acceptable for the durability guarantee.
- Failed emissions surface as `EMISSION_FAILED` system events, giving the actor a chance to react.
