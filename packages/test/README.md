# @actor-kit/test

Test harness for Actor Kit actors -- run transitions without the Cloudflare runtime.

## Install

```bash
pnpm add -D @actor-kit/test
```

## Usage

```ts
import { testActor } from "@actor-kit/test";
import { counterContract } from "./contract";

const t = testActor(counterContract);

// Initialize with default state
t.init();

// Send a message and assert the resulting state
t.send("increment", {});
expect(t.view("anyone").count).toBe(1);

// send() always returns { state, executions, links, unlinks, forwards }
const { state } = t.send("increment", {});
expect(state.count).toBe(2);
```

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

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
