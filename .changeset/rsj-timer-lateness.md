---
"@actor-kit/worker": patch
---

Docs: how late timers fire ("How late they fire" in the timers concept page). Production alarms fire tens to a few hundred milliseconds after the deadline (Run Set Jimmy: 243 ms); the runtime sets the alarm to the exact deadline and fires every due timer in the same alarm, adding 0-2 ms locally, so there was no delay in actor-kit to remove.
