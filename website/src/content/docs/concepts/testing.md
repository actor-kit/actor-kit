---
title: Testing
description: How to test actors at every level — from pure functions to full-stack browser tests.
---

## Testing strategy

Actor Kit is designed for the [testing trophy](https://kentcdodds.com/blog/write-tests) — invest most in the middle layers where you get the highest confidence per test.

```
             ╱╲
            ╱  ╲           E2E (Playwright)
         ╱──────╲
        ╱          ╲
       ╱            ╲      Actor tests (testActor)
      ╱              ╲     + Integration (vitest-pool-workers)
       ╲            ╱
        ╲──────────╱
         ╲        ╱        Unit (pure functions)
          ╲──────╱
     ━━━━━━━━━━━━━━━━━     Static analysis (TypeScript + Biome)
```

The widest part is the middle: actor tests and integration tests give you the most confidence that your actor behaves correctly. Unit tests cover pure helpers. E2E proves the full stack works in a browser.

Static analysis is the foundation — TypeScript strict mode and Biome catch entire categories of bugs before any test runs.

## Four test levels

### 1. Static analysis

TypeScript strict mode (no `any`, no `as` casts) and Biome linting. These run on every save and in pre-commit hooks.

```bash
pnpm typecheck   # strict TypeScript, zero errors
pnpm lint         # Biome: formatting, import ordering, no-explicit-any
```

### 2. Unit tests

Pure function tests with Vitest. No Actor Kit APIs, no Cloudflare runtime — just input/output.

```typescript
import { describe, expect, it } from "vitest";
import { encode, decode } from "@actor-kit/core";
import { PlayerView } from "./schemas";

describe("binary encoding", () => {
  it("round-trips a player view", () => {
    const data = { x: 1.5, y: 2.5, health: 100, name: "alice", alive: true };
    const bytes = encode(PlayerView, data);
    const decoded = decode(PlayerView, bytes);
    expect(decoded).toEqual(data);
  });
});
```

Good for: schema encoding/decoding, JWT helpers, pure utility functions.

### 3. Actor tests with `testActor()`

`testActor()` is the workhorse of Actor Kit testing. It runs your full actor definition — role evaluation, message routing, Zod validation, guards, view projection, and side effect capture — without a Cloudflare runtime.

```typescript
import { testActor } from "@actor-kit/test";
import { CounterContract } from "./counter.contract";

const t = testActor(CounterContract);
```

`testActor()` accepts a contract (from `kit.actor()`) — types for `init()`, `send()`, `view()`, and `role()` are all inferred from the contract.

**Initialize state** from input:

```typescript
const state = t.init({});
```

**Send messages** and get back the result (state + captured effects):

```typescript
const { state: next } = await t.send(state, "alice", { type: "INCREMENT" });
```

**Check which role** a caller resolves to:

```typescript
expect(t.role(state, "alice")).toBe("user");
```

**Compute a view** for a caller and verify the projection:

```typescript
const { role, data } = t.view(state, "alice");
expect(role).toBe("user");
expect(data.count).toBe(0);
```

**Refused messages throw** a `RefusalError` (from `@actor-kit/core`) carrying the refusal's `code` (`unknown_message`, `invalid_payload`, `guard_failed`, `wrong_state`, `no_role`) and the whole value as `.refusal`:

```typescript
import { RefusalError } from "@actor-kit/core";

await expect(t.send(state, "alice", { type: "RESET" })).rejects.toThrow(RefusalError);
await expect(t.send(state, "alice", { type: "RESET" })).rejects.toMatchObject({ code: "guard_failed" });
```

Actors with states work the same way: `init()` returns the persisted state `{ shared, phase, locals, stateTimers }`, and `send()` moves between phases as the runtime does.

**Capture service calls** without executing them:

```typescript
const { state: next, executions } = await t.send(
  state, "alice", { type: "NOTIFY_MEMBERS" }
);

expect(executions).toContainEqual(
  expect.objectContaining({ service: "notifications" })
);
```

Actor tests are fast (pure TypeScript, no I/O) and cover the most important behavior: does this message, from this caller, in this state, produce the right result?

### 4. Integration tests with `vitest-pool-workers`

Real Durable Objects, real SQLite, real WebSocket — running in the Cloudflare Workers test runtime.

**Spawn and query an actor:**

```typescript
import { env } from "cloudflare:test";

const id = env.COUNTER.idFromName("test-1");
const stub = env.COUNTER.get(id);

await stub.spawn({ actorId: "test-1", caller: "u1", callerType: "user", input: {} });
const result = await stub.send("u1", "user", { type: "INCREMENT", amount: 5 });
// { ok: true }, or a refusal: { ok: false, code, message, expected?, details?, docs }

const snapshot = await stub.getSnapshot("u1", "user");
expect(snapshot.snapshot.count).toBe(5);
```

Good for: persistence across restarts, WebSocket lifecycle, binary frame encoding over the wire, DO Alarms, outbox drain and side effect delivery.

### 5. E2E tests with Playwright

Real browser, real Worker, real Durable Object. Proves the full stack works end-to-end.

```typescript
import { test, expect } from "@playwright/test";

test("increment button increases count", async ({ page }) => {
  await page.goto("/?id=test-" + Date.now());
  await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });

  await page.locator("#increment").click();
  await expect(page.locator("#count")).toHaveText("1", { timeout: 3000 });
});
```

```typescript
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

Good for: multi-user sync, UI rendering, full auth flow, client reconnection behavior.

## What to test where

| Concern | Unit | Actor (`testActor`) | Integration (DO) | E2E |
|---------|------|---------------------|-------------------|-----|
| Schema encoding/decoding | ✓ | | | |
| JWT helpers | ✓ | | | |
| Role evaluation | | ✓ | ✓ | |
| Message routing | | ✓ | ✓ | |
| Zod validation | | ✓ | ✓ | |
| Guards | | ✓ | ✓ | |
| View projection | | ✓ | ✓ | |
| Emission capture | | ✓ | | |
| Persistence | | | ✓ | |
| WebSocket lifecycle | | | ✓ | |
| Binary delta frames | | | ✓ | |
| DO Alarms | | | ✓ | |
| Multi-user sync | | | | ✓ |
| Browser rendering | | | | ✓ |
| Full auth flow | | | | ✓ |

## Running tests

```bash
pnpm typecheck          # static analysis
pnpm test:unit          # unit + actor tests (vitest)
pnpm test:integration   # DO integration tests (vitest-pool-workers)
pnpm test               # all of the above
```

## Related

- [Testing Side Effects](/recipes/testing-side-effects/) — how to capture and assert `execute()` calls
- [actor-kit/test API Reference](/api/test/) — full `testActor()` API documentation
