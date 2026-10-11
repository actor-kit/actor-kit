---
"@actor-kit/worker": major
"@actor-kit/core": minor
"@actor-kit/test": major
"@actor-kit/studio": minor
---

ADR-019 A: hierarchical states. A state may declare `initial` and child `states` (and `exit`); `setup({ states })` declarations nest (`{ local?, input?, states? }`) and `kit.in(["playing", "window"])` gives a child's helpers. The persisted state is `{ shared, phase, locals, stateTimers }` with `phase` a path (`["round"]` for a flat actor) and one local and one scoped-timer list per level; a Durable Object stored in the 0.2 flat shape is read as its one-element path on load. `ctx.local` is the merge of a handler's local and its ancestors' (typed as their intersection); messages and timers are looked up innermost first; `goto(path, shared, input?)` exits to the common ancestor and enters down to the target (always re-entering the target; a parent enters its `initial`); `scope: "state"` timers belong to the level that scheduled them. `enter` may return `ctx.stay(shared, local)` to change the shared state; `exit(shared, ctx)` returns the next shared state. New: `matches()` and `localOf()` for views and roles, path types (`PathsOf`, `LeafPathsOf`, `MergedLocal`, ...), `PhaseHelpers` exported, error codes `missing_state_input` and `invalid_transition`. `ContractMessages` includes nested states' messages; testActor/simulate snapshots are typed per leaf path. Studio's State panel names the active path and the timeline marks path changes. A compile-time budget (`pnpm typecheck:budget`) guards the state-tree types.
