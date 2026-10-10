# @actor-kit/worker

Define actors with typed contracts, create Durable Object classes, and stamp caller identity.

## Install

```bash
pnpm add @actor-kit/core @actor-kit/worker zod
```

## Usage

```ts
import { nullable, schema, string, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, message } from "@actor-kit/worker";
import { z } from "zod";

const CounterView = schema({ count: uint32, lastUpdatedBy: nullable(string) });

export const Counter = defineActor("counter", {
  input: z.object({}),
  init: () => ({ count: 0, lastUpdatedBy: null as string | null }),
  roles: {
    admin: (_s, _caller, { callerType }) => callerType === "service",
    user: () => true,
  },
  messages: {
    INCREMENT: message(z.object({}), (state, _p, { caller }) => ({ count: state.count + 1, lastUpdatedBy: caller })),
    RESET: message(z.object({}), {
      guard: (_s, _p, ctx) => ctx.role === "admin",
      handler: () => ({ count: 0, lastUpdatedBy: null }),
    }),
  },
  views: {
    admin: view.shared(CounterView, (s) => s),
    user: view.shared(CounterView, (s) => s),
  },
});

// worker.ts: the Durable Object class
export const CounterDO = createActorClass(Counter);
```

Handlers are synchronous reducers. Read time and randomness through `ctx.now()`, `ctx.id()` and
`ctx.random()`; the runtime records them so the journal can be replayed.

## Timers

```ts
ctx.schedule("roundEnd", { in: "30s", key: "round-1", payload: { round: 1 } }); // in any handler
ctx.cancel("round-1");
```

Declared in a `timers` block with `timer(schema, handler)`, saved to SQLite and fired by the Durable
Object alarm, so they survive hibernation and deploys.

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
