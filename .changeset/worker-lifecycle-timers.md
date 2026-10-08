---
"@actor-kit/worker": patch
---

A lifecycle `connect`/`disconnect` handler that only schedules or cancels a timer (state unchanged, no executions or forwards) is now committed; before, its timer operations were dropped.
