---
"@actor-kit/worker": minor
"@actor-kit/core": minor
"@actor-kit/test": patch
---

A Worker's binding typed from the actor class (`DurableObjectNamespace<InstanceType<typeof RoomActor>>`) now types every RPC result: `getSnapshot` resolves to `ContractSnapshot<typeof Contract>` (one member per role, `role` narrows `snapshot` to that role's view; it was `never`), `send` to `{ ok: true } | RpcRefusal` (the refusal half was `never`), `__inspect().state` to the contract's persisted state, `__getView` per role, and `__journal` entries with JSON causes. New exports: `ContractSnapshot`, `ContractViewResult`, `InspectedState`, `RpcRefusal`, `RpcJournalPage`, `ViewData` (`@actor-kit/worker`); `ContractState`, `ContractInput` and `JsonValue` move to `@actor-kit/core` (`@actor-kit/test` re-exports the first two).
