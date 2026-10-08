---
title: "@actor-kit/test"
description: Test helper reference.
---

The test package (`@actor-kit/test`) provides a test harness that runs actor transitions without a Cloudflare runtime.

## `testActor(contract)` / `testActor(def)`

Creates a test harness for an actor. Accepts either a contract (from `defineActor()`) or a raw definition object.

### Contract-derived (recommended)

Types for `init()`, `send()`, `view()`, and `role()` are all inferred from the contract:

```typescript
import { testActor } from "@actor-kit/test";
import { CounterContract } from "./counter.contract";

const t = testActor(CounterContract);
```

### `t.init(input)`

Validates input with Zod and returns the initial state.

```typescript
const state = t.init({});
// state: { count: 0, lastUpdatedBy: null }
```

Throws if input is invalid.

### `t.send(state, caller, message, opts?)`

Resolves the caller's role, validates the message, runs the handler. Returns `{ state, executions, links, unlinks, forwards, schedules, cancels, timeline }` (`schedules` and `cancels` record `ctx.schedule` / `ctx.cancel` calls; timers do not run, use `simulate()`).

```typescript
let state = t.init({});
({ state } = await t.send(state, "alice", { type: "INCREMENT" }));
```

Capture side effects:

```typescript
const { state: next, executions } = await t.send(
  state, "alice", { type: "NOTIFY" }
);

expect(executions).toHaveLength(1);
expect(executions[0]).toEqual({ service: "EMAIL", input: { ... } });
```

Throws if:
- No role matches the caller
- Zod validation fails
- Guard returns false

Options: `{ callerType: "service" }` to override the default "user".

### `t.view(state, caller, opts?)`

Resolves the caller's role and returns `{ role, data }`.

```typescript
const view = t.view(state, "alice");
expect(view.role).toBe("user");
expect(view.data.count).toBe(0);
```

### `t.role(state, caller, opts?)`

Returns the role name or `null`.

```typescript
expect(t.role(state, "alice")).toBe("user");
expect(t.role(state, "admin", { callerType: "service" })).toBe("admin");
```

## Observability

If the actor definition has `observe.onTransition`, `testActor` fires it after each successful `send()`:

```typescript
const transitions = [];
const def = {
  // ...
  observe: {
    onTransition(prev, next, event, ctx) {
      transitions.push({ prev, next, eventType: event.type });
    },
  },
};
```

## `simulate(options?)`

Many actors on a virtual clock, with effects as data (ADR-015 D4). Every transition runs through the same step core
as the Durable Object, so a simulation behaves like the runtime without the Workers runtime, a browser or real time.

```typescript
import { replayJournal, simulate } from "@actor-kit/test";

const sim = simulate({ contracts: [AuctionContract, LobbyContract], seed: 42, now: Date.UTC(2026, 0, 1) });
const room = await sim.spawn(AuctionContract, "lamp-sale", { item: "lamp" });

room.send("alice", { type: "BID", amount: 10 });             // { ok: true } or { ok: false, error, detail? }
room.send("ops", { type: "CLOSE" }, { callerType: "service" });
room.view("alice");                                           // the caller's role view
room.state;                                                   // typed from the contract

const [charge] = sim.pendingEffects();                        // services never run on their own
sim.resolve(charge, { receipt: "r1" });                       // runs onDone (sim.reject → onError)

sim.advance("30s");                                           // fires due timers in (fireAt, id) order

const other = sim.branch();                                   // an independent copy to explore another ending
await replayJournal(AuctionContract, room.journal);           // every simulated journal replays exactly
```

- **Options**: `contracts` (reachable by name for forwards and init links; spawned contracts are added), `seed`
  (for `ctx.id()` and `ctx.random()`, default 1), `now` (start of the virtual clock, default 0), `env`.
- **`spawn(contract, id, input, { caller, callerType }?)`**: parses the input and runs `init` (async). Init links
  read the linked actor's view as a service caller.
- **`actor(contract, id)`**: a handle with `state`, `journal`, `timers`, `links`, `send`, `role`, `view` and
  `connect(caller)`, which runs `lifecycle.connect` and returns `{ disconnect() }`. `callerConnections` counts the
  caller's open simulated connections, as the runtime counts sockets.
- **`pendingEffects()`**: service executions as `{ actor, effectId, service, input }`. `resolve` / `reject` take
  the effect, or its effect id when that is unique across actors.
- **`advance(duration)`**: moves the clock; each due timer fires on its own deadline (`ctx.lateBy` is 0).
- **Forwards** are delivered at once with the original caller; `failedForwards()` lists those whose target was
  never spawned.
- Link views are pushed as the runtime pushes them: after every committed transition a source sends each actor linked to it its view (projected for the caller `<source type>:<subscriber id>`, a service), only when it changed; the subscriber runs `link.onUpdate` with the role added. A new link, also one made in `init`, gets the current view at once.
