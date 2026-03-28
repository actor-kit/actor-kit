---
title: Testing Side Effects
description: How to verify emit() calls without executing them.
---

Side effects (`emit()`) are recorded during transitions but not executed in `testActor()`. This lets you assert exactly what was emitted without hitting external services.

## Capturing emissions

Use `sendWithEffects()` instead of `send()`:

```typescript
import { testActor } from "actor-kit/test";
import { OrderContract } from "./order";

const t = testActor(OrderContract);
let state = t.init({ items: ["widget"] });

const { state: next, emissions } = t.sendWithEffects(
  state, "alice", { type: "PLACE_ORDER" }
);
```

`emissions` contains every `emit()` call made during the transition.

## Asserting fire-and-forget effects

```typescript
// Verify a queue emission
expect(emissions).toContainEqual(
  expect.objectContaining({
    queue: "ORDER_QUEUE",
    body: expect.objectContaining({ items: ["widget"] }),
  })
);

// Verify an actor-to-actor emission
expect(emissions).toContainEqual(
  expect.objectContaining({
    actor: "INVENTORY",
    id: "warehouse-1",
    message: "RESERVE_ITEMS",
  })
);

// Verify a fetch emission
expect(emissions).toContainEqual(
  expect.objectContaining({
    fetch: expect.stringContaining("api.example.com"),
  })
);
```

## Asserting no side effects

```typescript
const { emissions } = t.sendWithEffects(
  state, "alice", { type: "INCREMENT" }
);

expect(emissions).toHaveLength(0);
```

## Asserting emission counts

```typescript
const { emissions } = t.sendWithEffects(
  state, "alice", { type: "NOTIFY_ALL" }
);

// Exactly 3 notifications sent
expect(emissions).toHaveLength(3);

// All went to the same queue
expect(emissions.every(e => "queue" in e && e.queue === "NOTIFICATIONS")).toBe(true);
```

## Integration testing side effects

`testActor()` captures but doesn't execute effects. To test actual delivery (outbox drain, retry behavior, actor-to-actor), use integration tests with `vitest-pool-workers`:

```typescript
import { env } from "cloudflare:test";

const id = env.ORDER.idFromName("test-order");
const stub = env.ORDER.get(id);

await stub.spawn({ actorId: "test-order", caller: "alice", callerType: "user", input: { items: ["widget"] } });
await stub.send("alice", "user", { type: "PLACE_ORDER" });

// The outbox drains asynchronously — the target actor receives the message
const inventory = env.INVENTORY.get(env.INVENTORY.idFromName("warehouse-1"));
const snapshot = await inventory.getSnapshot("system", "service");
expect(snapshot.snapshot.reserved).toContain("widget");
```
