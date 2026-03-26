# Progress
Working memory for ralph-package-split. Delete after run.
---
## Task 1: Create @actor-kit/core — DONE
- Created `packages/core/` with package.json, tsconfig.json, tsdown.config.ts
- Source files: schema.ts, binary.ts, delta.ts, frame.ts, types.ts, view.ts, index.ts
- types.ts contains shared types extracted from message.ts and callback.ts: CallbackDef, Effect, RequestConfig, NormalizedRequestConfig, normalizeRequest, EmitFn, RequestFn, MessageDef, MessageContext
- view.ts contains ViewDef interface and view() function
- All imports updated to use relative paths within the package
- `pnpm typecheck` passes for both @actor-kit/core and full workspace
