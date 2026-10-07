---
"@actor-kit/studio": patch
---

Harden the Studio middleware: only `/__studio` and `/__studio/*` are intercepted; path and query params are parsed with Zod (400 on bad input instead of a thrown URIError or a 500); looking up an unknown actor is a 404 checked against the new `StudioRegistry.hasActor()` and never auto-spawns a phantom actor; unknown API routes are JSON 404s; non-GET/HEAD is 405; SPA deep links work for actor ids containing dots; error bodies are JSON. The embedded UI no longer ships stale build output (`emptyOutDir`).
