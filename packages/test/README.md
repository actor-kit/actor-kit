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

// Capture side effects
const { state, emissions } = t.sendWithEffects("increment", {});
expect(state.count).toBe(2);
```

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
