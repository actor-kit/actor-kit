---
"@actor-kit/test": major
"@actor-kit/worker": minor
---

ADR-018 D: `testActor()` runs on the runtime's pure `step()` core, like `simulate()`. It now runs actors with states (`init` returns `{ shared, phase, local, stateTimers }`, typed per phase), refuses undeclared timers and invalid timer payloads like the runtime, reports the scoped timers a phase change cancels in `cancels`, and throws a `RefusalError` with a `code` (`unknown_message`, `invalid_payload`, `guard_failed`, `wrong_state`, `no_role`) for a refused message.
