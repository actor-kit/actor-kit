---
"@actor-kit/worker": minor
"@actor-kit/test": minor
---

Typed `env` (ADR-016 §4).

- An optional `env` Zod object on the contract, with binding helpers `service<T>()`, `durableObject<T>()`, `queue<T>()`, `kv()`, `r2()`, `d1()` exported from `@actor-kit/worker`; they check a binding's runtime shape and type it.
- The Durable Object parses the env once, before it serves anything. If it does not parse, every request is refused (a 500 from `fetch`, the same message thrown from RPC) naming each missing or wrong binding, one `actor_kit.env.invalid` line is logged, and no handler ever runs.
- `defineActor` types a service's `fn` env, `onDone`/`onError`'s `ctx.env` (new: service callbacks now get `ctx.env`) and lifecycle `ctx.env` as `z.infer<typeof env>`; `unknown` without a schema. Handlers and services see the parsed env (declared bindings only).
- `testActor(contract, { env })` and `simulate({ env: { contractName: fakes } })` take fakes typed against the schema and parse them the same way.
