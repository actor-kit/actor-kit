# 009: Observability Hooks

**Priority**: ~~P2~~ Superseded
**Status**: Superseded by [012: SQLite Storage Layer](./012-sqlite-storage-layer.md)
**Affects**: `createMachineServer.ts`, types

---

> **Note**: This proposal has been consolidated into [012: SQLite Storage Layer](./012-sqlite-storage-layer.md), which implements observability via XState's built-in inspect API feeding structured transition/event data into DO SQLite. The lifecycle hooks proposed here are replaced by the inspect-based approach, which captures richer data (including internal XState events) with less custom code.

---

## Original Problem

Actor-kit has basic `DEBUG_LEVEL` logging but no structured observability. In production, you can't:

- Trace which events caused which transitions
- Monitor persistence latency
- Alert on error states
- Measure event processing time
- Track WebSocket connection health

See [012](./012-sqlite-storage-layer.md) for the consolidated solution.
