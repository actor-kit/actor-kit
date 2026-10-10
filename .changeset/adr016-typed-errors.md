---
"@actor-kit/worker": minor
"@actor-kit/test": minor
"@actor-kit/studio": minor
---

Typed, tagged service errors (ADR-016 §2).

- A service may declare `errors` (a `z.discriminatedUnion("_tag", ...)`) and fail with `throw fail({ _tag, ... })` (`fail` from `@actor-kit/worker`). The runtime parses the value against `errors`; one that doesn't parse, or anything else thrown, is `{ _tag: "Defect", message }`. A try that runs out of time is `{ _tag: "Timeout", ms }`.
- **Breaking:** `onError` receives that typed error instead of `{ message }` (a Defect keeps `message`). `defineActor` types it per service (declared errors plus the built-ins) and types `retry.while` the same way.
- Default retry rule: the built-ins are retried, declared errors are not (a declined card fails at once and `onError` runs). `retry.while(error)` overrides it, for services and for link forwards.
- The journal stores the parsed error, so replay and restore deliver the same value. The outbox keeps the error's tag (`last_error_tag`, migration `0014_last_error_tag`); Studio's Outbox shows it in the Last error column, and the `actor_kit.outbox.failed` event carries `errorTag`. A declared error's fields are redacted by `studio.redact` like payloads.
- `simulate().reject(effect, error)` takes typed errors: declared ones are parsed against the service's `errors` (and refused when they don't parse), the built-ins are accepted, and a string or `{ message }` is a Defect.
- Type tests (`tests/unit/*.types.test.ts`) are now checked by `pnpm typecheck` (`typecheck:types`).
