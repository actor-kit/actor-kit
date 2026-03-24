---
title: Testing
description: Unit tests, integration tests, and E2E tests.
---

## Testing Trophy

Actor Kit is designed for the [testing trophy](https://kentcdodds.com/blog/write-tests) — more integration tests, fewer unit tests.

```
        /\
       /  \       E2E (Playwright — real browser)
      /----\
     /      \     Integration (vitest-pool-workers — real DO)
    /--------\
   /          \   Unit (vitest — pure functions)
  /------------\
```

## Unit Tests with `testActor()`

`testActor()` runs transitions without a CF runtime — pure TypeScript, fast.

```typescript
import { testActor } from "actor-kit/test";
import { TodoList } from "./todo";

const t = testActor(TodoList);

// Init
const state = t.init({ creator: "alice" });

// Send messages
const next = await t.send(state, "alice", { type: "ADD_TODO", text: "Buy milk" });

// Check role
expect(t.role(state, "alice")).toBe("owner");

// Get view
const view = t.view(state, "alice");
expect(view.role).toBe("owner");

// Capture emissions
const { state: s, emissions, requests } = await t.sendWithEffects(
  state, "alice", { type: "NOTIFY" }
);
```

Good for: role evaluation, message routing, view computation, emission capture.

## Integration Tests with `vitest-pool-workers`

Real Durable Objects, real SQLite, real WebSocket.

```typescript
import { env } from "cloudflare:test";

const id = env.COUNTER.idFromName("test-1");
const stub = env.COUNTER.get(id);

await stub.spawn({ actorId: "test-1", caller: "u1", callerType: "user", input: {} });
await stub.send("u1", "user", { type: "INCREMENT", amount: 5 });

const snapshot = await stub.getSnapshot("u1", "user");
expect(snapshot.snapshot.count).toBe(5);
```

Good for: persistence, WebSocket lifecycle, binary frames, alarms, outbox drain.

## E2E Tests with Playwright

Real browser, real Worker, real Durable Object.

```typescript
import { test, expect } from "@playwright/test";

test("increment button increases count", async ({ page }) => {
  await page.goto("/?id=test-" + Date.now());
  await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });
  await page.locator("#increment").click();
  await expect(page.locator("#count")).toHaveText("1", { timeout: 3000 });
});

test("two browsers see the same counter", async ({ browser }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  await page1.goto("/?id=shared");
  await page2.goto("/?id=shared");

  await page1.locator("#increment").click();
  await expect(page2.locator("#count")).toHaveText("1", { timeout: 3000 });
});
```

Good for: full-stack proof, multi-user sync, UI behavior.

## What to test where

| Concern | Unit | Integration | E2E |
|---------|------|-------------|-----|
| Role evaluation | ✓ | ✓ | |
| Message routing | ✓ | ✓ | |
| Zod validation | ✓ | ✓ | |
| Guards | ✓ | ✓ | |
| View projection | ✓ | ✓ | |
| Persistence | | ✓ | |
| WebSocket lifecycle | | ✓ | |
| Binary delta frames | | ✓ | |
| DO Alarms | | ✓ | |
| Multi-user sync | | | ✓ |
| Browser rendering | | | ✓ |
| Full auth flow | | | ✓ |
