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

## Domain events

`testActor(...).send()` returns `emitted`; `simulate()` exposes `sim.events()`; `replayJournal()`
fails at the first emitted event that differs from the journal.

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
