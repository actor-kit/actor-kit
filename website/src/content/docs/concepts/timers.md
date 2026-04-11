---
title: Timers
description: Using DO alarms and setInterval directly.
---

## DO Alarms

Actor Kit does not provide a built-in timer abstraction. Message handler context (`ctx`) does not expose `ctx.storage`.

For scheduling with DO Alarms, access `this.ctx.storage.setAlarm()` directly in a custom DO class that extends the actor class, or use Cloudflare's alarm API outside Actor Kit's abstraction. Services (`fn(input, env)`) do not have access to `ctx.storage`.

See the [Cloudflare Durable Objects Alarms documentation](https://developers.cloudflare.com/durable-objects/api/alarms/) for details.
