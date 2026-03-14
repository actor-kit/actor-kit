# Checksum-Based Sync Protocol

**Date**: 2026-03-14
**Status**: Accepted (retrospective)
**Deciders**: Jonathan Mumm

## Context

Actor-kit needs to synchronize state between the Durable Object (server) and multiple WebSocket clients efficiently. Sending full state on every transition wastes bandwidth, especially for large contexts with many connected clients.

## Decision

Use checksum-based deduplication with JSON Patch diffs.

Each snapshot is hashed. The server tracks the last checksum sent to each WebSocket. On transition:
1. Compute new checksum
2. For each client: if checksums differ, compute JSON Patch diff and send operations
3. If checksums match, skip that client

Additionally, cache recent snapshots (keyed by checksum, 5-minute TTL) so reconnecting clients can receive a diff from their last-known state.

### Why

- **Bandwidth efficiency**: JSON Patch operations are much smaller than full snapshots for typical mutations (e.g., toggling a todo sends ~50 bytes vs ~2KB full state)
- **Reconnection support**: Snapshot cache enables efficient reconnection without replaying events
- **Simplicity**: Checksums are cheap to compute and compare

### Trade-offs

- **Collision risk**: Current 32-bit hash has non-trivial collision probability at scale. See roadmap proposal 008 for migration to SHA-256.
- **Memory**: Snapshot cache grows with unique states × connected clients. Mitigated by 5-minute TTL and periodic cleanup.
- **Ordering**: JSON Patch assumes ordered application. A missed patch corrupts state. Mitigated by checksum validation on each patch.

## Consequences

- Clients must track their current checksum and send it on reconnect
- Server must maintain per-WebSocket state (last sent checksum)
- The `fast-json-patch` library is a core dependency
- Client applies patches using `immer` for immutable updates
