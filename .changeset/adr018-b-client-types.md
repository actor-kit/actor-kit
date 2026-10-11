---
"@actor-kit/core": minor
"@actor-kit/worker": minor
---

ADR-018 B: `ContractMessages<T>` (typed client `send`, refs, `simulate().send`) now includes every state's messages, not only top-level ones. `kit.in(phase).state({ messages })` keeps its message names and payload types.
