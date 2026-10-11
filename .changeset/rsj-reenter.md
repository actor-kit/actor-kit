---
"@actor-kit/worker": minor
---

`ctx.reenter(shared, input?)` in a state's handlers re-enters the current state on purpose (exit cancels its scoped timers and drops its local, then `enter` runs again). `goto` to the current state does the same, as now documented; `ctx.stay` keeps the local and timers.
