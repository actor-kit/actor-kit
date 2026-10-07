---
"@actor-kit/worker": patch
"@actor-kit/studio": patch
---

Studio UI: parse every WebSocket frame and API response with Zod and show malformed data as an error instead of crashing; reconnect with backoff without duplicating timeline entries; show readable 401/403/404/500/network error states (404 keeps polling until the actor exists); de-duplicate connections; race-safe dashboard search; dashboard pagination; studio key prompt on 401; manual connect validation; truncate very large JSON. Worker: live `studio.timeline` entries now include their row `id`, and `webSocketClose` answers the peer's close frame so browser sockets don't stay in CLOSING.
