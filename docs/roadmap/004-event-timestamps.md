# 004: Event Timestamping at Ingestion

**Priority**: ~~P1~~ Superseded
**Status**: Superseded by [012: SQLite Storage Layer](./012-sqlite-storage-layer.md)
**Affects**: `createMachineServer.ts`, types, schemas

---

> **Note**: This proposal has been consolidated into [012: SQLite Storage Layer](./012-sqlite-storage-layer.md), which combines event timestamps, event logging, and observability into a single DO SQLite-backed initiative. The requirements from this proposal (server-injected `_timestamp` and `_seq` on every event) are fully addressed in 012.

---

## Original Problem

Actor-kit doesn't stamp events with a server-authoritative timestamp. This creates two problems:

1. **Non-deterministic guards**: If a guard uses `Date.now()`, replaying the same events at a different time produces different state. This blocks event sourcing (see 006).

2. **No canonical ordering**: When multiple clients send events concurrently, there's no server-assigned ordering beyond "whatever the DO processed first." This matters for scoring in games — Trivia Jam calculates speed-based scores using `answer.timestamp` which is set client-side (`Date.now()` in the browser). A cheating client could fake timestamps.

See [012](./012-sqlite-storage-layer.md) for the consolidated solution.
