---
"@actor-kit/client": minor
---

`actorClient().create({ initialView })` validates the boot view against the view schema (for a contract, the schema of the role the view names) and throws `InitialViewError` (`code: "invalid_initial_view"`, issues with paths, docs URL) on a mismatch.
