# @actor-kit/test

> **Docs for agents and humans:** this package ships its documentation in [`docs/`](docs/README.md) (matching the installed version). The whole site is at https://actorkit.dev, with https://actorkit.dev/llms.txt (an index) and https://actorkit.dev/llms-full.txt (everything in one file) for agents. Every error and refusal carries a `code` documented at https://actorkit.dev/errors/.


Test harness for Actor Kit actors -- run transitions without the Cloudflare runtime.

## Install

```bash
pnpm add -D @actor-kit/test
```

## Usage

```ts
import { RefusalError } from "@actor-kit/core";
import { testActor } from "@actor-kit/test";
import { CounterContract } from "./contract"; // from counter.actor(...)

const t = testActor(CounterContract);

// Initialize from input
let state = t.init({});

// Send a message and assert the resulting state and view
({ state } = await t.send(state, "alice", { type: "INCREMENT" }));
expect(t.view(state, "alice").data.count).toBe(1);

// send() returns { state, executions, links, unlinks, forwards, schedules, cancels, emitted, timeline }

// A refused message throws a RefusalError with the refusal's code
await expect(t.send(state, "alice", { type: "RESET" })).rejects.toThrow(RefusalError);
```

`testActor` runs the runtime's own step core: actors with states work (`init` returns
`{ shared, phase, local, stateTimers }`), and undeclared timers and events are refused as in the
Durable Object. `simulate()`'s `send` returns `{ ok: true }` or the refusal
(`{ ok: false, code, message, expected?, details?, docs }`) instead of throwing.

## Typed env and determinism (ADR-016)

```ts
// Fakes typed against the contract's `env` schema, parsed like the runtime parses the Worker env
const t = testActor(CheckoutContract, { env: { PAYMENTS: fakePayments, STRIPE_KEY: "pk_test" } });
const sim = simulate({ env: { checkout: { PAYMENTS: fakePayments, STRIPE_KEY: "pk_test" } } });

// A service failure as onError gets it: declared ({ _tag: "CardDeclined", ... }), Timeout or Defect
sim.reject(effect, { _tag: "CardDeclined", reason: "stolen" });
```

While a handler runs under `testActor()`, `simulate()` or `replayJournal()`, `Date.now()`, `new Date()`,
`performance.now()`, `Math.random()`, `crypto.randomUUID()` and `crypto.getRandomValues()` throw
`NondeterminismError`: use `ctx.now()`, `ctx.random()` and `ctx.id()`.

## Domain events

`testActor(...).send()` returns `emitted`; `simulate()` exposes `sim.events()`; `replayJournal()`
fails at the first emitted event that differs from the journal.

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
