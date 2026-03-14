# 006: Optional Event Log

**Priority**: ~~P2~~ Superseded
**Status**: Superseded by [012: SQLite Storage Layer](./012-sqlite-storage-layer.md)
**Affects**: `createMachineServer.ts`, new module, types

---

> **Note**: This proposal has been consolidated into [012: SQLite Storage Layer](./012-sqlite-storage-layer.md), which stores events in a structured SQLite table inside the Durable Object rather than using the KV-style `storage.put()` approach originally proposed here. The requirements from this proposal (append-only event log, rolling window, redaction, checkpoint replay) are fully addressed in 012.

---

## Original Problem

Actor-kit is snapshot-only. There is no record of what events produced the current state. This blocks:

- **Audit trails**: Who did what, when? (compliance, debugging)
- **Time-travel debugging**: Step through event history to find bugs
- **Replay**: Reconstruct state from events after a schema migration
- **Analytics**: Query event streams for usage patterns

See [012](./012-sqlite-storage-layer.md) for the consolidated solution.
