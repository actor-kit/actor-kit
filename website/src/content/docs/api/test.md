---
title: "@actor-kit/test"
description: Test helper reference.
---

The test package (`@actor-kit/test`) provides a test harness that runs actor transitions without a Cloudflare runtime.

## `testActor(contract)` / `testActor(def)`

Creates a test harness for an actor. Accepts either a contract (from `kit.actor()`) or a raw definition object. It runs the runtime's own step core (admission, handlers, states, declared-timer and declared-event checks), so a test behaves like the Durable Object.

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

Throws if input is invalid. For an actor with states, `init` returns the persisted state `{ shared, phase, locals, stateTimers }`, typed per phase.

### `t.send(state, caller, message, opts?)`

Resolves the caller's role, validates the message, runs the handler. Returns `{ state, executions, links, unlinks, forwards, schedules, cancels, emitted, timeline }` (`schedules` and `cancels` record `ctx.schedule` / `ctx.cancel` calls, including the scoped timers a phase change cancels; timers do not run, use `simulate()`). Scheduling a timer the actor does not declare throws, as in the runtime.

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

A refused message throws a `RefusalError` (from `@actor-kit/core`): `.code` is the refusal code and `.refusal` the whole `{ ok: false, code, message, expected?, details?, docs }` value. The codes:
- `no_role` — no role matches the caller
- `unknown_message` — the caller's role has no message of that name
- `wrong_state` — only other states accept the message
- `invalid_payload` — Zod validation fails
- `guard_failed` — guard returns false

```typescript
import { RefusalError } from "@actor-kit/core";

await expect(t.send(state, "alice", { type: "RESET" })).rejects.toThrow(RefusalError);
await expect(t.send(state, "alice", { type: "RESET" })).rejects.toMatchObject({ code: "guard_failed" });
```

`testActor(contract, { env })` takes fakes typed against the contract's `env` schema and parses them like the runtime parses the Worker env (a mismatch throws, naming each binding); handlers see the parsed env.

Options: `{ callerType: "service" }` to override the default "user"; `{ delivery }` to send the message as a forward would (`ctx.delivery`, ADR-016), e.g. to test that a handler ignores a retried delivery.

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

room.send("alice", { type: "BID", amount: 10 });             // { ok: true } or a Refusal { ok: false, code, message, ... }
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
  (for `ctx.id()` and `ctx.random()`, default 1), `now` (start of the virtual clock, default 0), `env` (for a contract with an `env` schema: fakes keyed by contract
  name, `{ checkout: { PAYMENTS: fake } }`, parsed against it when the actor is spawned; other contracts get `env` as is).
- **`spawn(contract, id, input, { caller, callerType }?)`**: parses the input and runs `init` (async). Init links
  read the linked actor's view as a service caller.
- **`spawnSync(contract, id, input, { caller, callerType }?)`**: `spawn` without `await`, for an actor whose
  `init` is synchronous and makes no init links (an async init throws `async_handler`, a `link()` in init
  throws `link_unavailable`: use `spawn`). Same journal and handle; handy with `branch()` for templates.
- **`actor(contract, id)`**: a handle with `state`, `journal`, `timers`, `links`, `send`, `role`, `view` and
  `connect(caller)`, which runs `lifecycle.connect` and returns `{ disconnect() }`. `callerConnections` counts the
  caller's open simulated connections, as the runtime counts sockets.
- **`pendingEffects()`**: service executions as `{ actor, effectId, service, input }`. `resolve` / `reject` take
  the effect, or its effect id when that is unique across actors. `reject` takes a typed error (ADR-016): a declared
  one (`{ _tag: "CardDeclined", reason }`, parsed against the service's `errors`, and refused if it doesn't parse),
  `{ _tag: "Timeout", ms }`, `{ _tag: "Defect", message }`, or a string / Error-like `{ message }` (a Defect).
- **`advance(duration)`**: moves the clock; each due timer fires on its own deadline (`ctx.lateBy` is 0).
- **Forwards** are delivered at once with the original caller and the forward's effect as the target's
  `ctx.delivery` (try 1); `failedForwards()` lists those whose target was
  never spawned.
- Link views are pushed as the runtime pushes them: after every committed transition a source sends each actor linked to it its view (projected for the caller `<source type>:<subscriber id>`, a service), only when it changed; the subscriber runs `link.onUpdate` with the role added. A new link, also one made in `init`, gets the current view at once.

## Determinism guards

While a handler runs under `testActor()`, `simulate()` or `replayJournal()` (message handlers, lifecycle, timers, `init`, `onDone`, `onError` and link callbacks), `Date.now()`, `new Date()` without arguments, `performance.now()`, `Math.random()`, `crypto.randomUUID()` and `crypto.getRandomValues()` throw `NondeterminismError` (exported from `@actor-kit/test`), telling you to use `ctx.now()`, `ctx.random()` or `ctx.id()`. A handler that reads the clock fails its first unit test instead of only failing replay. The globals are restored afterwards, also when the handler throws. A service's `fn` is exempt, and the Workers runtime never patches globals.
