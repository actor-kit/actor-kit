---
"@actor-kit/worker": minor
---

ADR-020 E (opt-in): `heartbeat: { staleMs }` on an actor closes app sockets whose client heartbeat stopped for longer than `staleMs` and runs their disconnect lifecycle, so a player whose phone slept and later left goes offline. Off unless set; sockets that never pinged are never closed. The chat-room example opts in with 60 s.
