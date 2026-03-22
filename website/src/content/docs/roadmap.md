---
title: Roadmap
description: What's planned for Actor Kit — completed features, in-progress work, and future proposals.
---

Actor Kit is under active development. Each proposal includes a problem statement, proposed API, implementation approach, and test plan. Proposals are prioritized by impact.

## Completed

| Feature | Description | PR |
|---------|-------------|----|
| Event Queuing | Queue events sent before WebSocket connects, deliver on connection | [#11](https://github.com/actor-kit/actor-kit/pull/11) |
| Collision-Resistant Checksums | Upgrade from 32-bit hash to SHA-256 for sync checksums | [#12](https://github.com/actor-kit/actor-kit/pull/12) |
| Monorepo Split | Split actor-kit into 7 scoped `@actor-kit/*` packages | [#30](https://github.com/actor-kit/actor-kit/pull/30) |
| Mock Client | `createActorKitMockClient` for testing without a live server | [#29](https://github.com/actor-kit/actor-kit/pull/29) |
| Trigger API | `client.trigger` proxy for typed event dispatch | [#28](https://github.com/actor-kit/actor-kit/pull/28) |

## P0 — Critical

These are blocking production usage and are the current focus.

### SQLite Storage Layer

Replace snapshot-only persistence with structured SQLite storage using Durable Object SQL API. This consolidates three earlier proposals (event timestamps, event log, observability) into a single storage rework.

**Solves:** No event history, broken `getSnapshot()` serialization, no observability hooks.

### Explicit Persistence Control

Apps currently resort to object-spread hacks and localStorage fallbacks to force persistence timing. This will provide explicit APIs for controlling when and what gets persisted.

## P1 — High Priority

Significant developer experience improvements.

### DO Alarm-Based Persistence

Use Durable Object alarms to batch persistence writes, protecting against data loss from DO eviction while reducing write frequency.

### First-Class Remote Actor References

Inter-actor communication currently requires custom workarounds and manual state sync. This will provide a `fromActorKit()` helper for XState's actor model to connect actors across Durable Objects.

### Documentation Site

You're looking at it. Starlight-based docs with llms.txt, copy-page buttons, and comprehensive API reference.

## P2 — Medium Priority

### Typed Actor References

Compile-time validation of events sent between actors. Currently, cross-actor events are untyped — this will enforce type safety at the actor boundary.

## P3 — Nice to Have

### Snapshot Projections

Reduce boilerplate when syncing child actor state into a parent actor's context.

### Machine-Running Mock Client

A mock client that actually runs the XState machine, catching logic bugs that the current Immer-based mock can't detect.

### Undo/Redo

Time-travel UI support built on the event log from the SQLite storage layer.

---

All proposals live in [`docs/roadmap/`](https://github.com/actor-kit/actor-kit/tree/main/docs/roadmap) with full detail. Have a feature request? [Open a discussion](https://github.com/actor-kit/actor-kit/discussions).
