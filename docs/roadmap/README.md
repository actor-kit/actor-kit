# Actor-Kit Roadmap

This directory contains detailed proposals for actor-kit improvements, organized by priority.

Each proposal includes:
- **Problem statement** with real-world evidence from production apps (Piqolo, Trivia Jam)
- **Proposed API** with code examples showing before/after
- **Implementation approach** with key files and changes
- **Test plan** with specific test cases

## Proposals

### P0 — Critical (blocking production usage)

| Proposal | Problem | Doc |
|----------|---------|-----|
| [Explicit Persistence Control](./001-explicit-persistence.md) | Apps resort to object-spread hacks and localStorage fallbacks to force persistence | `001` |
| [Event Queuing Before Connection](./002-event-queuing.md) | Events sent before WebSocket ready are silently dropped | `002` |

### P1 — High (significant DX improvement)

| Proposal | Problem | Doc |
|----------|---------|-----|
| [First-Class Remote Actor References](./003-remote-actor-refs.md) | Inter-actor communication requires custom workarounds and manual state sync | `003` |
| [Event Timestamping](./004-event-timestamps.md) | No framework-level timestamp injection; blocks future event sourcing | `004` |
| [DO Alarm-Based Persistence](./005-alarm-persistence.md) | No protection against Durable Object eviction data loss | `005` |

### P2 — Medium (correctness + observability)

| Proposal | Problem | Doc |
|----------|---------|-----|
| [Optional Event Log](./006-event-log.md) | No audit trail, no replay, no debugging timeline | `006` |
| [Typed Actor References](./007-typed-actor-refs.md) | No compile-time validation of events sent between actors | `007` |
| [Collision-Resistant Checksums](./008-better-checksums.md) | 32-bit hash has high collision probability | `008` |
| [Observability Hooks](./009-observability.md) | No structured way to trace transitions, persistence, or errors | `009` |

### P3 — Low (DX polish)

| Proposal | Problem | Doc |
|----------|---------|-----|
| [Snapshot Projections](./010-snapshot-projections.md) | Manual PROFILE_UPDATED → assign boilerplate for child actor state | `010` |
| [Machine-Running Mock Client](./011-machine-mock-client.md) | Storybook mock client can't catch machine logic bugs | `011` |

## In-Repo Skills

Skills that should ship with actor-kit to help developers:

| Skill | Purpose |
|-------|---------|
| `actorkit-storybook-testing` | Testing actor-kit components in Storybook with mock clients and play functions |
| `actorkit-tanstack-start` | Full integration guide for TanStack Start/Router apps |
