---
"@actor-kit/worker": major
"@actor-kit/test": minor
---

Typed version chain (ADR-015 D5, ADR-013 step 4). `versions: [version(n, Schema, { state, events, rebuild: "replay" })]` replaces `version` + `migrate`; contracts that still use those options are refused (no compatibility shim). Each step is typed against the previous version's state and the last version must describe what `init` returns. Older stored state is parsed with its version's schema and stepped, or rebuilt by replaying the journal under the new handlers with older message payloads upcast; the bump is journaled as a `migrate` event with a checkpoint. `replayJournal()` refuses events written by versions with no path to the current one and starts at the last bump. `simulate()` and `replayJournal()` compile the chain like the runtime.
