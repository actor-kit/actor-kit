# ADR 021: Exactly-once client sends

**Date**: 2026-10-18
**Status**: Proposed (spike on branch `claude/adr-021-spike`; adopting it is Jon's call)
**Depends on**: ADR-020 (heartbeat, resync)

## Context

A client message is delivered at most once. `send()` writes to the socket and forgets the message.
A socket can be dead while still reporting OPEN (iOS froze the page; Wi-Fi changed). A tap
written to it is lost. ADR-020's heartbeat then finds the dead socket and reconnects, but nothing
resends the tap. `tests/integration/client-seam-delivery.test.ts` "today: at most once" shows it.

Resending alone is not safe either. If the message arrived and only the answer was lost, a resend
applies it twice: a double bid, two moves.

## Decision (proposed)

Opt-in per client: `createActorClient({ exactlyOnce: true })`, also on `actorClient(...).create()`.
Off by default, so nothing changes for existing apps.

- **Ids.** The client gives each message an id, `__id`: the client's random id plus a counter.
  The id is unique per client instance; a page reload starts a new client, and sends from before
  the reload are not resent.
- **Pending until acked.** The client keeps every message it sent until the actor answers
  `{"type":"__ack","id"}`. When a socket opens, it sends `__reconnect` (as today), then every
  unacked message in the order they were first sent, then any queued ones.
- **The actor dedupes.** A message carrying `__id` is checked against a `delivered_messages`
  table (caller, id) in the actor's SQLite. A repeat is not applied, only acked again. A new one is
  applied (or refused), recorded and acked. A refusal is acked too: a message the actor refused is
  not resent. The `__id` is stripped before the message reaches its schema and handler.
- **Bounded memory.** The actor keeps the last 1 000 delivered ids. A resend older than that would
  apply again; resends happen within seconds of the original.
- **Survives hibernation and restart.** The table lives in SQLite, not in memory.

## Spike limits (to settle before adopting)

- The id is recorded right after the transition, in the same request with no I/O in between. It is
  not inside the transition's own `transactionSync`, so a crash between the two could still apply
  a resend twice. The real version writes the id in the commit's transaction, and gets a numbered
  migration instead of `CREATE TABLE IF NOT EXISTS`.
- Ids are per client instance. Exactly-once across a page reload would need ids kept in
  `sessionStorage`.
- RPC `send()` from other actors already has `delivery` and effect ids (ADR-016); this is only for
  WebSocket clients.

## Consequences

- One small ack frame per message, both ways.
- Apps that opt in should treat `send()` as "will be applied once, eventually, while the client
  lives", not "applied now".
