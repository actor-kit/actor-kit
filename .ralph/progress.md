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

## Task 2: Create @actor-kit/worker — DONE
- Created `packages/worker/` with package.json, tsconfig.json, tsdown.config.ts
- Source files: actor.ts, message.ts, callback.ts, ref.ts, auth.ts, index.ts
- Runtime files: runtime/message-router.ts, runtime/outbox.ts, runtime/roles.ts, runtime/states.ts, runtime/timers.ts, runtime/route-to-actor.ts, runtime/cdc.ts
- All imports updated: `../schema/*` → `@actor-kit/core`, `../core/message` → `@actor-kit/core`
- message.ts keeps only `message()` function, imports `MessageDef`/`MessageContext` types from core
- callback.ts keeps only `callback()` function, imports `CallbackDef` type from core
- Built @actor-kit/core first (required for workspace resolution)
- `pnpm typecheck` passes for full workspace (core, actor-kit, worker)
- All 277 unit tests pass
- Codex review: 3 P2 findings, all pre-existing code or by-design — no regressions

## Task 3: Create @actor-kit/client — DONE
- Created `packages/client/` with package.json, tsconfig.json, tsdown.config.ts
- Source files: client.ts, builder.ts, index.ts
- client.ts: WebSocket client with binary frame handling, JSON fallback, reconnection
- builder.ts: Typed actorClient() factory builder with schema inference
- All imports updated: `../schema/*` → `@actor-kit/core`
- tsconfig.json includes `"DOM"` in lib (browser APIs: WebSocket, TextDecoder, ArrayBuffer)
- `pnpm typecheck` passes for full workspace (core, actor-kit, worker, client)
- All 277 unit tests pass
- Codex review: 1 P1 finding (dist/ not present until build) — same pattern as core/worker, by-design for workspace packages

## Task 4: Create @actor-kit/react — DONE
- Created `packages/react/` with package.json, tsconfig.json, tsdown.config.ts
- Source files: context.ts, actor-context.ts, index.ts
- context.ts: createActorContext() with Provider + useView/useSend/useRole/useConnectionState/useSelector hooks
- actor-context.ts: actorContext() convenience wrapper that infers types from ActorClientFactory
- All imports updated: `../client/client` → `@actor-kit/client`, `../client/builder` → `@actor-kit/client`
- tsconfig.json includes `"DOM"` in lib and `"jsx": "react-jsx"`
- Dependencies: `@actor-kit/client` (workspace), `react` (peer dep >=18)
- `pnpm typecheck` passes for full workspace (core, actor-kit, worker, client, react)
- All 277 unit tests pass
- Codex review: 2 P1 findings (stale view on client swap in useView, stale selection in useSelector) — both are pre-existing bugs from original actor-kit/src/react/context.ts, not regressions from the split

## Task 5: Create @actor-kit/test — DONE
- Created `packages/test/` with package.json, tsconfig.json, tsdown.config.ts
- Source files: test-actor.ts, index.ts
- test-actor.ts: testActor() harness — init, role, send, sendWithEffects, view
- Imports `routeMessage`/`resolveRole` from `@actor-kit/worker/testing` (not root — avoids cloudflare:workers)
- Added `@actor-kit/worker/testing` subpath export: separate entrypoint (testing.ts) with only pure-logic runtime functions
- Updated worker package.json (exports), tsdown.config.ts (entry), added src/testing.ts
- `pnpm typecheck` passes for full workspace (core, actor-kit, worker, client, react, test)
- All 277 unit tests pass
- Codex review round 1: 1 P1 (importing worker root pulls in cloudflare:workers) — fixed with ./testing subpath
- Codex review round 2: 1 P3 (`this`-bound send() breaks on destructure) — fixed by extracting sendWithEffectsImpl as closed-over function

## Task 6: Update workspace and remove old package — DONE
- Updated biome.json `files.includes` to add all 5 new package paths alongside existing `packages/actor-kit/src/**/*.ts`
- Updated root package.json `lint` and `lint:fix` scripts to include all new package src/ dirs
- Ran `pnpm lint:fix` to auto-fix import ordering in new packages (10 files fixed)
- pnpm-workspace.yaml unchanged — `packages/*` glob already covers all new packages
- Physical removal of `packages/actor-kit/` deferred: 49 test files + 4 example projects still import from it via relative paths / package name. Removal blocked until tasks 7-9 migrate those imports.
- `pnpm typecheck` passes for full workspace
- `pnpm lint` passes (exit 0, only pre-existing warnings)
- All 277 unit tests pass
- Codex review: 1 P3 (lint dropping old package from scope) — fixed by keeping `packages/actor-kit/src` in both biome.json and lint scripts

## Task 7: Update unit test imports — DONE
- Updated all 40 test files (39 .test.ts + 1 .test.tsx) to import from `@actor-kit/*` packages instead of relative paths to `packages/actor-kit/src/`
- Import mapping: schema/* + core/view → `@actor-kit/core`; core/message, core/callback, core/ref, auth/*, runtime/* → `@actor-kit/worker/testing`; client/* → `@actor-kit/client`; react/* → `@actor-kit/react`; test/* → `@actor-kit/test`
- Expanded `@actor-kit/worker/testing` subpath to include ALL pure-logic exports: message, callback, createRef, createAccessToken, getCallerFromToken, parseDuration, parseActorRoute, createOutbox, createChangeEntry, resolveMessagesForState (+ types)
- Added `resolve.alias` in `vitest.config.ts` to map workspace packages to source files — avoids requiring `pnpm build` before `pnpm test:unit`
- Tests import from `@actor-kit/worker/testing` (not `@actor-kit/worker` root) to avoid cloudflare:workers dependency
- Ran `pnpm lint:fix` to auto-fix import ordering in 39 files
- `pnpm typecheck` passes for full workspace
- `pnpm lint` passes (only pre-existing warnings)
- All 277 unit tests pass across all 40 test files
- Codex review: no findings — "did not find a concrete functional regression or a discrete bug"
