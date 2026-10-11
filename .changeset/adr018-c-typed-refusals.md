---
"@actor-kit/core": minor
"@actor-kit/worker": major
"@actor-kit/client": major
"@actor-kit/test": major
"@actor-kit/react": patch
"@actor-kit/studio": patch
"@actor-kit/studio-cli": patch
---

ADR-018 C: typed refusals and errors that teach. `send()` results (Durable Object RPC, `ActorRef`, `simulate()`) are `{ ok: true } | Refusal` with `code`, a full-sentence `message` naming the fix, `expected`, `details` and a `docs` URL; codes `message_not_found` and `validation_failed` are now `unknown_message` and `invalid_payload`. The `__error` frame and the client's `onError` carry the same fields. Every thrown library error is an `ActorKitError` with a stable `code` and `docs` URL; `ERROR_CODES` in `@actor-kit/core` is the registry.
