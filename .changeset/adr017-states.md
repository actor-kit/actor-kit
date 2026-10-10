---
"@actor-kit/core": minor
"@actor-kit/worker": minor
"@actor-kit/test": minor
"@actor-kit/studio": minor
---

States with typed locals (ADR-017 §1): optional `initial` + `states`. The persisted state is `{ shared, phase, local, stateTimers }`; handlers return `ctx.stay(shared, local?)`, `ctx.goto(phase, shared, input?)` or the shared state; exit drops the local and cancels `scope: "state"` timers; `enter` builds the next local. Messages are accepted only in their states plus top-level ones (`wrong_state` otherwise, before guards). `setup({ events, states })` and `quiz.in(phase)` give typed `local`, `stay`, `goto` and `enter`. `simulate()` and replay run them through the step core; Studio marks phase changes. New `examples/quiz` contract.
