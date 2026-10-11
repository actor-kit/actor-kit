---
"@actor-kit/test": minor
"@actor-kit/worker": patch
---

`simulate().spawnSync(contract, id, input)` spawns without `await` when `init` is synchronous and makes no init links (an async init or an init link throws with a code that says to use `spawn()`); same journal and handle as `spawn()`.
