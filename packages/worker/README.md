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

## Services

Async work goes through the outbox (at-least-once, retried, journaled). Pass `effect.idempotencyKey` downstream, and fail with typed errors:

```ts
import { fail } from "@actor-kit/worker";

services: {
  charge: {
    errors: z.discriminatedUnion("_tag", [z.object({ _tag: z.literal("CardDeclined"), reason: z.string() })]),
    fn: async (input: { cents: number }, env, effect) => {
      const res = await chargeCard(input, { idempotencyKey: effect.idempotencyKey });
      if (!res.ok) throw fail({ _tag: "CardDeclined", reason: res.reason });
      return res.receipt;
    },
    // error: CardDeclined | { _tag: "Timeout", ms } | { _tag: "Defect", message }
    onError: (state, error) => (error._tag === "CardDeclined" ? { ...state, declined: error.reason } : state),
  },
},
```

Declared errors are not retried (a declined card is an answer); timeouts and defects are, unless `retry.while` says otherwise.

## Domain events

Declare `events` and emit them with `setup({ events })` helpers (typed `ctx.emit`); they are
journaled with the transition that emitted them. See the Domain events concept page.

`publish: { queue, events }` sends them to a Queue binding (declare it in `env`) through the outbox, like a
service: each message's `idempotencyKey` is the effect's (`${actorType}/${actorId}/${seq}:${index}`), each
try has the default 30-second timeout, and timeouts and defects are retried.

## States

Optional `initial` + `states` with typed locals and `scope: "state"` timers, typed through
`setup({ events, states })` and `kit.in(phase)`. See the States concept page and `examples/quiz`.

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
