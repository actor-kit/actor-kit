---
"@actor-kit/core": minor
"@actor-kit/client": minor
"@actor-kit/worker": minor
"@actor-kit/projection": minor
---

ADR-018 C error codes for the ADR-019 C/E/F features: `invalid_schema`, `invalid_view_value` (also `SchemaValidationError`), `invalid_frame` for undecodable bytes, `invalid_journal_query`, `invalid_projection`, `incomplete_journal`, and `invalid_initial_view` (`InitialViewError` is an `ActorKitError`). The typed `actorClient<typeof C>({ roles, views })` validates `initialView` too.
