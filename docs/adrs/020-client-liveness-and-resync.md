# ADR 020: Client liveness and resync

**Date**: 2026-10-17
**Status**: Accepted (Jon, 2026-10-18: heartbeat on by default)
**Depends on**: ADR-005 (binary sync)

## Context

Every OGS cast party game runs on phones, iPads and a TV, with one actor per room. Games hit two
kinds of "the phone is behind" bugs: a game-level one (a phone shown an older, TV-paced state after
its own action; fixed in the games with a floor on the batch shown) and library-level ones, which
`tests/integration/client-seam.test.ts` now drives with the real client against a real actor. The
library held up through drops, restarts, hibernation and two tabs of one player, but three cases
left a client stale with nothing to tell it so:

1. **A socket that went silent.** iOS freezes a backgrounded page and can kill its TCP connection
   without the page ever seeing a `close` (half-open socket). On show, the client's `visibilitychange`
   handler only skipped a pending backoff wait; with no close there was no wait, so the phone kept a
   dead socket that still reported `OPEN`, showed the room as it was when the iPad went to sleep, and
   dropped every tap. The same happens to a visible page when Wi-Fi changes under it.
2. **A send in the closing window.** `send()` dropped a message when the socket was no longer open
   but its `close` event had not run yet (state still `connected`).
3. **A frame that does not decode.** The client kept its last good view and the server kept sending
   deltas against the view it believed the client had, so the client stayed behind until the next
   reconnect.

## Decisions

### A. Heartbeat (client option, on by default)

`createActorClient({ heartbeat })`, also accepted by `actorClient(...).create()`:
`{ intervalMs?: number; timeoutMs?: number } | false`, default `{ intervalMs: 20_000, timeoutMs: 5_000 }`.

- While a socket is open the client sends `{"type":"__ping"}` every `intervalMs`. Any frame from the
  server counts as alive. If nothing arrives within `timeoutMs` of a ping, the socket is abandoned
  (closed, its late events ignored through the existing generation check) and a new one opens at
  once, without the backoff wait: the reopen sends `__reconnect` with the last checksum, as today.
- The page becoming visible and the browser's `online` event send a ping at once (a probe), so a
  phone that slept finds out within `timeoutMs` instead of never.
- `false` turns the heartbeat off (the probe on show/online too), for tests and for apps that run
  their own.

### B. The actor answers pings without waking

The actor class registers `ctx.setWebSocketAutoResponse` for `{"type":"__ping"}` → `{"type":"__pong"}`
in its constructor. The runtime answers it without running the actor, so a hibernated room stays
hibernated (no duration billed) and the ping never reaches `webSocketMessage`.

### C. Sends wait for the next socket

`send()` queues a message whenever the socket is not open and the client is not `disconnected`
(previously only in `connecting`/`reconnecting`), so a tap in the closing window is delivered after
the reconnect, in order with the rest of the queue.

### D. Resync on a frame that does not decode

A binary frame that throws while parsing or decoding makes the client send
`{"type":"__reconnect","lastChecksum":<last good view>}` on the open socket. The actor already
answers that with `__reconnect_ack` (views equal) or a full snapshot. At most one request is
outstanding: another is only sent after a frame has applied, so a snapshot that the client cannot
decode (a client bundle older than the Worker) does not loop. A frame that fails while a request is
outstanding, or before any view applied, is reported once through `onError` as `invalid_frame`
("Reload the page"), again only after a frame applies in between.

`decode` and `applyDelta` read the whole payload: one that ends early or has bytes left over is
`invalid_frame` (it was written with another schema or damaged), never a view with a string cut
short or a delta read as "nothing changed". `parseFrame` refuses a frame shorter than its header says.

### E. The actor closes sockets whose heartbeat stopped (opt-in)

**Accepted 2026-10-18 as opt-in** (coordinator, for Jon: new behaviour is additive; turning it on
by default is Jon's decision).

A phone that slept leaves a half-open socket on the actor's side; the client opens a new one, but
the actor never learns the old one died, so a player who later leaves stays online (the chat
example counted them twice over; a seat stays "connected").

- `heartbeat: { staleMs }` on the actor turns it on; omitted, nothing changes. The chat example
  opts in with 60 s (three client intervals).
- Whenever the actor runs for an app (a message or RPC send, a socket closing, a new connection), it
  closes app sockets whose last auto-answered ping (`ctx.getWebSocketAutoResponseTimestamp`) is more
  than `staleMs` ago, with code 4001 "heartbeat stopped", and runs their disconnect lifecycle.
  Sockets that never pinged (heartbeat off, an older client) are never closed.
- A closed socket is marked `reaped` in its attachment: it is no longer a live connection, and if
  its close event does arrive later, the disconnect lifecycle does not run twice.
- Not on a timer: an idle room with nobody acting keeps the dead socket until the next event (no
  alarm is spent on it).
- Cost to weigh before a default: a device locked for longer than `staleMs` gets `disconnect`, then
  `connect` when it wakes; a game that frees a seat on disconnect frees it.

## Consequences

- A client and a Worker must both be at this version: an older actor has no auto-response, so its
  `webSocketMessage` would refuse `__ping` as an unknown message (an `onError` every 20 s). Actor Kit
  ships client and worker together (`docs/vendoring.md`), so no compatibility shim.
- Each open socket costs one small message each way per `intervalMs`, answered by the runtime.
- Behaviour change: a socket that stays silent for `intervalMs + timeoutMs` is now replaced. One
  existing unit test left its fake server silent for 60 s (`client-reconnect-resilience.test.ts`,
  "ignores a late close event…"); it now passes `heartbeat: false`, as approved.
- A message sent on a socket that is already dead but still reports `OPEN` is lost, as before:
  delivery stays at most once. Fixing that needs message ids the actor dedupes on (a follow-up).

## Not decided here

- A schema hash in the frame, so a client can tell a newer schema from damage. Today a mismatch is
  caught when the payload does not fill exactly (most changes) and reported through `onError`; a
  change that keeps every byte length (a `uint32` renamed) is not detected.
