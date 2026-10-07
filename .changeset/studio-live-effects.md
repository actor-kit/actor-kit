---
"@actor-kit/worker": patch
"@actor-kit/studio": patch
---

Studio: the Outbox and Links panels now update live. Actors push `studio.outbox` when an execution is added or settles and `studio.links` when links or subscribers change. Worker: a link subscriber now registers under its actor ID instead of its hex Durable Object ID, so the target's view updates reach it (before, they went to an empty actor named after the hex ID).
