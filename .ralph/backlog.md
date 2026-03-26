# Package Split Backlog

Split `packages/actor-kit/` into 5 separate `@actor-kit/*` npm packages.

## Dependency graph

```
@actor-kit/core     ← schema, view, binary, frame, types (CallbackDef, Effect, etc.)
                       deps: zod
    ↑         ↑
@actor-kit/worker   @actor-kit/client
(actor, message,    (actorClient, WS,
 callback, runtime,  reconnection)
 auth, outbox)       deps: @actor-kit/core
deps: @actor-kit/core,
      jose, cloudflare:workers
    ↑                    ↑
@actor-kit/test     @actor-kit/react
(testActor)         (actorContext, hooks)
deps: @actor-kit/core,  deps: @actor-kit/client,
      @actor-kit/worker        react (peer)
```

## What goes where

| Package | Source dirs | Key exports |
|---------|-----------|-------------|
| `@actor-kit/core` | schema/, binary, delta, frame, types | `schema()`, `view()`, `uint32`, `string`, `array()`, `Infer<>`, `encode()`, `decode()`, `CallbackDef`, `Effect`, `RequestConfig`, `NormalizedRequestConfig`, `MessageDef`, `ViewDef`, frame types |
| `@actor-kit/worker` | core/ (actor, message, callback, ref), runtime/, auth/ | `actor()`, `message()`, `callback()`, `createRef()`, `createAccessToken()`, `getCallerFromToken()`, `parseActorRoute()` |
| `@actor-kit/client` | client/ (client, builder) | `actorClient()`, `createActorClient()`, `ActorClient`, `ActorClientFactory`, `InferView`, `InferEvent` |
| `@actor-kit/react` | react/ (context, actor-context) | `actorContext()`, `createActorContext()` |
| `@actor-kit/test` | test/ (test-actor) | `testActor()` |

## No re-exports between packages. Explicit imports only.

## Tasks

- [x] **1. Create @actor-kit/core** — Create `packages/core/` with package.json (`@actor-kit/core`, dep: `zod`), tsconfig.json, and `src/` containing: schema.ts, binary.ts, delta.ts, frame.ts. Also extract shared types from message.ts (CallbackDef, Effect, RequestConfig, NormalizedRequestConfig, normalizeRequest, EmitFn, RequestFn, MessageDef, MessageContext) and view.ts (ViewDef, view()). Create `src/index.ts` exporting everything. Build with tsdown. Verify: `pnpm typecheck` passes for the new package.

- [x] **2. Create @actor-kit/worker** — Create `packages/worker/` with package.json (`@actor-kit/worker`, deps: `@actor-kit/core`, `zod`, `jose`). Move: actor.ts, message.ts (keep only `message()` and `callback()` implementations, import types from core), ref.ts, and full runtime/ and auth/ dirs. Update all imports from `../schema/` to `@actor-kit/core`. Create `src/index.ts`. Verify: `pnpm typecheck` passes.

- [x] **3. Create @actor-kit/client** — Create `packages/client/` with package.json (`@actor-kit/client`, dep: `@actor-kit/core`). Move: client.ts, builder.ts. Update imports from `../schema/` to `@actor-kit/core`. Create `src/index.ts`. Verify: `pnpm typecheck` passes.

- [x] **4. Create @actor-kit/react** — Create `packages/react/` with package.json (`@actor-kit/react`, dep: `@actor-kit/client`, peer: `react`). Move: context.ts, actor-context.ts. Update imports. Create `src/index.ts`. Verify: `pnpm typecheck` passes.

- [ ] **5. Create @actor-kit/test** — Create `packages/test/` with package.json (`@actor-kit/test`, deps: `@actor-kit/core`, `@actor-kit/worker`). Move: test-actor.ts. Update imports. Create `src/index.ts`. Verify: `pnpm typecheck` passes.

- [ ] **6. Update workspace and remove old package** — Update pnpm-workspace.yaml to include all new packages. Remove `packages/actor-kit/`. Update root package.json scripts. Update biome.json lint paths. Run `pnpm install`.

- [ ] **7. Update unit test imports** — Update all files in `tests/unit/` to import from `@actor-kit/core`, `@actor-kit/worker`, `@actor-kit/client`, `@actor-kit/react`, `@actor-kit/test` instead of relative paths. Run `pnpm test:unit` — all 277 tests must pass.

- [ ] **8. Update integration test imports** — Update `tests/integration/src/worker.ts` and all integration test files to import from `@actor-kit/worker` and `@actor-kit/core`. Run `pnpm test:integration`.

- [ ] **9. Update examples** — Update all 4 example workers (counter, todo-list, chat-room, auction) to import from `@actor-kit/core` + `@actor-kit/worker`. Update their package.json deps.

- [ ] **10. Update docs site** — Update all 25 docs pages: change `import from "actor-kit"` to `import from "@actor-kit/worker"`, `"actor-kit/client"` to `"@actor-kit/client"`, etc. Update installation page with new package names. Build docs to verify.

- [ ] **11. Final verification** — Run full suite: `pnpm typecheck`, `pnpm test:unit` (277 tests), `pnpm test:integration` (45 tests), `pnpm lint`, docs build. Commit with detailed message.
