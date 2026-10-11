---
"@actor-kit/worker": minor
"@actor-kit/core": patch
---

ADR-018 A: one canonical shape, setup-first. `setup({ events?, states?, env? })` (everything optional) returns a kit; `kit.actor(name, def)` or `defineActor(name, kit, def)` defines the actor, taking the kit's events, env and state declarations (a kit with states requires `initial` and every state). Kit helpers type `ctx.env`, `emit`, `local`, `goto` and `stay` everywhere; the standalone `message()` / `timer()` are typed the same way, so their `ctx.emit` accepts no event. Examples use only this shape.
