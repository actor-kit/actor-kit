---
title: Timers
description: Durable timers that survive hibernation, restarts and deploys.
---

Actors schedule work for later with **timers** (ADR-015). A timer is declared once, scheduled from any handler with `ctx.schedule`, and fired by the Durable Object's alarm, even if the actor was evicted, hibernating or redeployed in between.

## Declaring timers

```typescript
import { defineActor, message, timer } from "@actor-kit/worker";
import { z } from "zod";

defineActor("quiz", {
  messages: {
    START_ROUND: message(z.object({}), (s, _p, ctx) => {
      const round = s.round + 1;
      ctx.schedule("roundEnd", { in: "30s", key: `round-${round}`, payload: { round } });
      return { ...s, round, phase: "answering" };
    }),
    SKIP: message(z.object({}), (s, _p, ctx) => {
      ctx.cancel(`round-${s.round}`);
      return { ...s, phase: "reveal" };
    }),
  },
  timers: {
    roundEnd: timer(z.object({ round: z.number() }), (s, { round }, ctx) =>
      s.round === round ? { ...s, phase: "reveal" } : s,
    ),
  },
});
```

- **`timer(schema, handler)`**: the payload schema and a synchronous handler `(state, payload, ctx) => state`. The handler gets `ctx.key`, `ctx.lateBy`, `ctx.now()/id()/random()`, `env`, and `execute`, `forward`, `schedule`, `cancel`. A timer has no caller and no role.
- **`ctx.schedule(name, { in | at, key?, payload? })`**: available in message, lifecycle and timer handlers. `in` is milliseconds or `"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"1d"`, counted from `ctx.now()`; `at` is an absolute time. Exactly one of them. The name must be declared and the payload must parse, or the handler throws and the transition is rejected.
- **`key`** is unique per actor: scheduling an existing key replaces that timer (debounce). Without a key, the timer's effect id is its key.
- **`ctx.cancel(key)`** removes a pending timer; cancelling a key that is not pending does nothing. Schedules and cancels apply in the order the handler made them.

## How they fire

- The schedule is written in the same transaction as the state change, into a `timers` table, with its absolute deadline. A transition that is rolled back schedules nothing.
- The actor keeps one Durable Object alarm at the earliest deadline (shared with outbox retries).
- When the alarm runs, every due timer fires, **late ones included**, in deadline order (ties in the order they were scheduled), each in its own transaction with its own journal event (`cause_type = "timer"`). `ctx.lateBy` says how late it fired; every timer fired by one alarm sees the same `ctx.now()`.
- Timers that a firing schedules wait for the next alarm, so a timer that reschedules itself with `in: 0` fires once per alarm, not in a loop.
- A timer whose payload no longer parses (its schema changed in a deploy) or whose transition fails is dropped and logged as an `actor_kit.timer.failed` event.
- Timers work with `journal: false`: the table is the truth.

## Studio

The **Timers** tab lists pending timers (name, key, due in, payload, with `studio.redact` applied). Admins (Studio's `mutate` scope) can **Fire now**, which runs the timer exactly as the alarm would.

## Testing

`testActor()` records `ctx.schedule` and `ctx.cancel` calls in `schedules` and `cancels` without running timers. To run timers on a virtual clock, use `simulate()`.
