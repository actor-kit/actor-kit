# @actor-kit/worker

> **Docs for agents and humans:** this package ships its documentation in [`docs/`](docs/README.md) (matching the installed version). The whole site is at https://actorkit.dev, with https://actorkit.dev/llms.txt (an index) and https://actorkit.dev/llms-full.txt (everything in one file) for agents. Every error and refusal carries a `code` documented at https://actorkit.dev/errors/.


Define actors with typed contracts, create Durable Object classes, and stamp caller identity.

## Install

```bash
pnpm add @actor-kit/core @actor-kit/worker zod
```

## Usage

```ts
import { nullable, schema, string, uint32, view } from "@actor-kit/core";
import { createActorClass, setup } from "@actor-kit/worker";
import { z } from "zod";

type State = { count: number; lastUpdatedBy: string | null };

const CounterView = schema({ count: uint32, lastUpdatedBy: nullable(string) });

// The kit: what the actor declares up front ({ events, states, env }, all optional).
const counter = setup({});

export const Counter = counter.actor("counter", {
  input: z.object({}),
  init: (): State => ({ count: 0, lastUpdatedBy: null }),
  roles: {
    admin: (_s: State, _caller: string, { callerType }: { callerType: "user" | "service" }) => callerType === "service",
    user: () => true,
  },
  messages: {
    INCREMENT: counter.message(z.object({}), (s: State, _p, { caller }) => ({ count: s.count + 1, lastUpdatedBy: caller })),
    RESET: counter.message(z.object({}), {
      guard: (_s: State, _p, ctx) => ctx.role === "admin",
      handler: () => ({ count: 0, lastUpdatedBy: null }),
    }),
  },
  views: {
    admin: view.shared(CounterView, (s: State) => s),
    user: view.shared(CounterView, (s: State) => s),
  },
});

// worker.ts: the Durable Object class
export const CounterDO = createActorClass(Counter);
```

`counter.actor(name, def)` (the same as `defineActor(name, counter, def)`) is the one way to define an
actor: the kit supplies `events`, `env` and the state declarations, and its helpers (`message`, `timer`,
`in(state)`) type `ctx.env`, `ctx.emit` and a state's `local` / `goto` / `stay`. Annotate the state type
once, on each handler's first parameter.

Handlers are synchronous reducers. Read time and randomness through `ctx.now()`, `ctx.id()` and
`ctx.random()`; the runtime records them so the journal can be replayed.

`stub.send(caller, callerType, message)` returns `{ ok: true }` or a refusal,
`{ ok: false, code, message, expected?, details?, docs }` (codes such as `unknown_message`,
`invalid_payload`, `guard_failed`, `wrong_state`, `no_role`). Every error the library throws is an
`ActorKitError` with a stable `code` and a `docs` URL.

## Timers

```ts
ctx.schedule("roundEnd", { in: "30s", key: "round-1", payload: { round: 1 } }); // in any handler
ctx.cancel("round-1");
```

Declared in a `timers` block with `kit.timer(schema, handler)`, saved to SQLite and fired by the Durable
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

Declare `events` in `setup({ events })` and emit them from the kit's handlers (typed `ctx.emit`); they
are journaled with the transition that emitted them. See the Domain events concept page.

`publish: { queue, events }` sends them to a Queue binding (declare it in the kit's `env`) through the outbox, like a
service: each message's `idempotencyKey` is the effect's (`${actorType}/${actorId}/${seq}:${index}`), each
try has the default 30-second timeout, and timeouts and defects are retried.

## States

Optional `initial` + `states` with typed locals and `scope: "state"` timers, typed through
`setup({ events, states })` and `kit.in(phase)`. See the States concept page and `examples/quiz`.

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
