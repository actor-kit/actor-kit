# Lessons
Patterns and mistakes. Review at start of each iteration.
---
- Bivariant method signatures (`handler(state: unknown)` not `handler: (state: unknown) =>`) are required for ActorDef to accept typed handlers. Don't convert to arrow function types.
- `cloudflare:workers` is a virtual module — it only resolves inside the CF runtime. Don't add it as a package dep.
- `pnpm-workspace.yaml` must list all packages or lockfile gets inconsistent.
- Schema types (CallbackDef, Effect, RequestConfig, NormalizedRequestConfig) are used by multiple packages — they go in @actor-kit/core.
- message() and callback() implementations are worker-only — they stay in @actor-kit/worker.
- view() is used in both worker definitions and client (actorClient takes the schema from view) — it goes in @actor-kit/core.
- No re-exports between packages. Explicit imports only.
- @actor-kit/core must be built (`pnpm --filter @actor-kit/core build`) before @actor-kit/worker can typecheck, because worker resolves core via `dist/index.d.ts`.
- Add `cloudflare:workers` to tsdown external list for worker package — it's a virtual module.
- Worker package needs `@cloudflare/workers-types` in devDependencies AND `types` in tsconfig.json for DO/WebSocket/WebSocketPair types.
- Client package needs `"DOM"` in tsconfig lib array for browser APIs (WebSocket, TextDecoder, ArrayBuffer, MessageEvent).
- Codex P1 about missing dist/ is expected for workspace packages — dist/ is built by `pnpm build`, not committed.
- React package needs `"jsx": "react-jsx"` in tsconfig.json even though source uses createElement (not JSX) — required for type resolution of React types.
- React package uses `react` as peerDependency, `@actor-kit/client` as regular dependency. Both must be externalized in tsdown.
- Codex findings about stale hook state on client swap (useView, useSelector) are pre-existing bugs from the original code — not regressions from the split.
