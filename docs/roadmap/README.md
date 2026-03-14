# Actor-Kit Roadmap

This directory contains detailed proposals for actor-kit improvements, organized by priority.

Each proposal includes:
- **Problem statement** with real-world evidence from production apps (Piqolo, Trivia Jam)
- **Proposed API** with code examples showing before/after
- **Implementation approach** with key files and changes
- **Test plan** with specific test cases

## Completed

| Proposal | PR | Date |
|----------|----|------|
| [Event Queuing Before Connection](./002-event-queuing.md) | [#11](https://github.com/actor-kit/actor-kit/pull/11) | 2026-03-14 |
| [Collision-Resistant Checksums](./008-better-checksums.md) | [#12](https://github.com/actor-kit/actor-kit/pull/12) | 2026-03-14 |

## Proposals

### P0 — Critical (blocking production usage)

| Proposal | Problem | Doc | Status |
|----------|---------|-----|--------|
| [Explicit Persistence Control](./001-explicit-persistence.md) | Apps resort to object-spread hacks and localStorage fallbacks to force persistence | `001` | Open |

### P1 — High (significant DX improvement)

| Proposal | Problem | Doc | Status |
|----------|---------|-----|--------|
| [First-Class Remote Actor References](./003-remote-actor-refs.md) | Inter-actor communication requires custom workarounds and manual state sync | `003` | Open |
| [Event Timestamping](./004-event-timestamps.md) | No framework-level timestamp injection; blocks future event sourcing | `004` | Open |
| [DO Alarm-Based Persistence](./005-alarm-persistence.md) | No protection against Durable Object eviction data loss | `005` | Open |

### P2 — Medium (correctness + observability)

| Proposal | Problem | Doc | Status |
|----------|---------|-----|--------|
| [Optional Event Log](./006-event-log.md) | No audit trail, no replay, no debugging timeline | `006` | Open |
| [Typed Actor References](./007-typed-actor-refs.md) | No compile-time validation of events sent between actors | `007` | Open |
| [Observability Hooks](./009-observability.md) | No structured way to trace transitions, persistence, or errors | `009` | Open |

### P3 — Low (DX polish)

| Proposal | Problem | Doc | Status |
|----------|---------|-----|--------|
| [Snapshot Projections](./010-snapshot-projections.md) | Manual PROFILE_UPDATED → assign boilerplate for child actor state | `010` | Open |
| [Machine-Running Mock Client](./011-machine-mock-client.md) | Storybook mock client can't catch machine logic bugs | `011` | Open |

## In-Repo Skills

Skills that should ship with actor-kit to help developers:

| Skill | Purpose |
|-------|---------|
| `actorkit-storybook-testing` | Testing actor-kit components in Storybook with mock clients and play functions |
| `actorkit-tanstack-start` | Full integration guide for TanStack Start/Router apps |
