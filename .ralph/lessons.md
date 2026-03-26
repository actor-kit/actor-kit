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
