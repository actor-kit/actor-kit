---
"@actor-kit/react": patch
"@actor-kit/client": minor
---

`actorContext(Contract).useClient(...)` decodes binary views with the contract's per-role schemas; before, the contract was ignored and a Worker sending binary (`withCallerIdentity(..., { supportsBinary: true })`) left React screens on their first view. `@actor-kit/client` exports `contractSchemas(def)` (a contract's role names and view schemas) for it.
