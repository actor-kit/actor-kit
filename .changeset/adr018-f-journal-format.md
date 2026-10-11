---
"@actor-kit/worker": minor
"@actor-kit/test": minor
"@actor-kit/studio": minor
---

ADR-018 F: the journal format, frozen for 0.3. `versions` steps take `emitted` upcasters and `renames` for domain events; replay (and now a rebuild by replay) compares recorded events upcast to the current version; `upcastEmitted()` reads journal entries in the current vocabulary. Refused messages are recorded outside the journal (`rejections` table, a count per code, a log line), and Studio shows the count. Lifecycle, service and link callbacks get a typed `ctx.emit` (`kit.service()`, new `kit.link()`); a callback that only emits is journaled and its published events are sent. A restore pushes the restored view to link subscribers.
