---
"@actor-kit/core": minor
"@actor-kit/worker": patch
---

`matches`, `localOf`, `mergeLocals` and the state-path types (`PathsOf`, `MergedLocal`, `PhasedState`, `LeafPathsOf`, ...) are exported from `@actor-kit/core`, which imports no zod at runtime, so view and role code imported by the browser stays zod-free. `@actor-kit/worker` re-exports the same functions and types. A test walks `@actor-kit/core`'s runtime import graph and asserts it imports no package.
