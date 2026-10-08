---
"@actor-kit/worker": minor
---

Pure step core (ADR-015 D4, Q4): `step(def, state, cause, facts, env)` and `stepInit()` in `@actor-kit/worker/testing` run one transition and return the next state, its effects and its journal event. The Durable Object and journal replay (`applyJournalEvent`) both run transitions through it; `admitMessage()` does the payload parsing and guard. No behaviour change. SQL rows and RPC replies in the runtime are now parsed with Zod instead of cast. The unused `toStudioConnections` export is removed.
