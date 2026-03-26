---
title: Testing Side Effects
description: How to verify emit() and request() calls without executing them.
---

Side effects (`emit()` and `request()`) are recorded during transitions but not executed in `testActor()`. This lets you assert exactly what was emitted without hitting external services.

## Capturing emissions

Use `sendWithEffects()` instead of `send()`:

```typescript
import { testActor } from "@actor-kit/test";
import { orderActorDef } from "./order";

const t = testActor(orderActorDef);
let state = t.init({ items: ["widget"] });

const { state: next, emissions, requests } = await t.sendWithEffects(
  state, "alice", { type: "PLACE_ORDER" }
);
```

`emissions` contains every `emit()` call. `requests` contains every `request()` call as `NormalizedRequestConfig` objects with `{ effect, onDone, onError, meta }`.

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

## Asserting async requests

`requests` captures `request()` calls as `NormalizedRequestConfig` objects:

```typescript
const { requests } = await t.sendWithEffects(
  state, "alice", { type: "FETCH_PRICE" }
);

expect(requests[0]).toMatchObject({
  effect: { fetch: "https://api.example.com/price" },
  onDone: "PRICE_RECEIVED",
  onError: "PRICE_FAILED",
  meta: { itemId: "widget" },
});
```

To test the callback handlers themselves, send the callback message directly:

```typescript
// Simulate the onDone callback
const afterSuccess = await t.send(
  next, "system", { type: "PRICE_RECEIVED", price: 42 },
  { callerType: "service" }
);
expect(afterSuccess.price).toBe(42);

// Simulate the onError callback
const afterFailure = await t.send(
  next, "system", { type: "PRICE_FAILED", message: "timeout" },
  { callerType: "service" }
);
expect(afterFailure.error).toBe("timeout");
```

## Asserting no side effects

```typescript
const { emissions, requests } = await t.sendWithEffects(
  state, "alice", { type: "INCREMENT" }
);

expect(emissions).toHaveLength(0);
expect(requests).toHaveLength(0);
```

## Asserting emission counts

```typescript
const { emissions } = await t.sendWithEffects(
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
