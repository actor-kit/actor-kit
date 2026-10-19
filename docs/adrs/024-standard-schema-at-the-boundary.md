# ADR 024: Standard Schema at the boundary

**Date**: 2026-10-18
**Status**: Accepted (Jon, via the Orchestrator: "go for it", option A)
**Depends on**: ADR-002 (parse at the boundary)

## Context

A game hands actor-kit its schemas: message payloads (`message()`), timer payloads (`timer()`),
JSON view fields (`json()`), the actor's `input`, `env`, `versions`, domain `events`, service
`errors`/`result`, state `local`/`input`. Every one of those parameters was typed `z.ZodType` from
zod 4. Nothing in `@actor-kit/core`, `@actor-kit/client` or `@actor-kit/react` imports zod at
runtime, but the types forced every game onto zod 4.

That costs the browser. A game's schemas are shared with its pages (a boot payload parsed on the
phone, a view type), so its zod ships to every phone. zod 4's classic build is about 95 KB gzipped
against about 15 KB for zod 3.25. Peekaboo-garden's join page went from 117 KB to 199 KB gzipped on
its first load, and its try-path speed test (a phone can join within 1.5 s on Fast 4G) started failing.

## Decision

Every schema a game passes to actor-kit is a **Standard Schema** (https://standardschema.dev): any
object with a `~standard` property whose `validate(value)` returns `{ value }` or `{ issues }`.
zod 3.24+, zod 4 (classic and mini), valibot and arktype all implement it.

- Types read a schema's output (and input, where actor-kit took zod's `z.input`) from
  `~standard.types`, through `SchemaOutput<S>` / `SchemaInput<S>` in `@actor-kit/core`.
- Runtime parses go through one helper, `parseSchema(schema, value)` in `@actor-kit/core`. It calls
  `~standard.validate` and returns `{ success, data }` or `{ success: false, issues, message }`, where
  `message` is the issues as JSON (what zod 4's `error.message` was, so refusal details don't change
  for zod 4 users). An async validator (a Promise result) throws `async_schema`: actor-kit's
  transitions are synchronous.
- actor-kit's own internal schemas stay zod 4. They run in the Worker only.
- `@actor-kit/core`, `@actor-kit/client` and `@actor-kit/react` stay zod-free at runtime, and a
  bundle-size check in CI keeps it so (a browser bundle of client + react + core, gzipped, with a
  budget, failing when zod or anything new lands in it).

## Consequences

- A game picks its validator by weight: zod 3.25 (the games' default today), zod/mini, valibot. zod 4
  classic keeps working unchanged.
- Refusal `issues` are Standard Schema issues (`{ message, path }`); for zod 4 they are zod's own issue
  objects, as before. Code that read zod-only fields from them (`code`, `expected`) still sees them
  with zod, and must not rely on them with another validator.
- `parseSchema` is public: a game's Worker can use it for its own boundaries.
- Not a breaking change for zod 4 users. A changeset (minor) records it.

## Alternatives considered

- **Type against zod 4's core (`$ZodType`)**, so zod/mini works: still zod 4 only, and actor-kit would
  need `zod/v4/core` at runtime to parse.
- **Each game rewrites its client-shared schemas in zod/mini**: works, but every game pays a rewrite,
  and the next validator change pays it again.
- **Loosen the speed budget**: the phones get slower.
