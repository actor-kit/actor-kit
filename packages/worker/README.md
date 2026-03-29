# @actor-kit/worker

Define actors with typed contracts, create Durable Object classes, and stamp caller identity.

## Install

```bash
pnpm add @actor-kit/core @actor-kit/worker zod
```

## Usage

```ts
import { defineActor, createActorClass, message } from "@actor-kit/worker";
import { withCallerIdentity } from "@actor-kit/worker";
import { z } from "zod";

const counter = defineActor({
  init: () => ({ count: 0 }),
  roles: {
    anyone: () => true,
  },
  messages: {
    anyone: {
      increment: message(z.object({}), (state) => ({
        ...state,
        count: state.count + 1,
      })),
    },
  },
});

// Generate the Durable Object class
export const Counter = createActorClass(counter);

// Stamp caller identity on incoming requests
export default { fetch: withCallerIdentity(/* ... */) };
```

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
