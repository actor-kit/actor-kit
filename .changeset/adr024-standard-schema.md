---
"@actor-kit/core": minor
"@actor-kit/worker": minor
"@actor-kit/test": minor
---

Any Standard Schema at the boundary (ADR-024): `message()`, `timer()`, `json()`, `input`, `env`, `versions`, `events`, service `errors`/`result` and state `local`/`input` take any Standard Schema (zod 3.24+, zod 4, zod/mini, valibot, arktype), not only zod 4. A game can stay on zod 3.25 and keep zod 4's weight off its pages. New in core: `parseSchema(schema, value)`, `issuePath(issue)`, and the `StandardSchema` / `SchemaOutput` / `SchemaInput` types. A browser-bundle budget in the unit tests keeps client + react + core free of dependencies.
