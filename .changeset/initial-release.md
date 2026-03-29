---
"@actor-kit/core": minor
"@actor-kit/worker": minor
"@actor-kit/client": minor
"@actor-kit/react": minor
"@actor-kit/test": minor
"@actor-kit/storybook": minor
---

Initial v0.1.0 release of Actor Kit.

Actors on the edge — each actor is a Cloudflare Durable Object with a mailbox, private state, and behavior you define. Binary state sync with per-client views.

Key features:
- `defineActor()` + `createActorClass()` for typed actor definitions with contracts
- Flat messages with role-based guards for authorization
- Binary-first sync with `schema()` builder, delta encoding, and per-role views
- Worker-trust auth model via `withCallerIdentity()` (JWT auth available as opt-in)
- Origin validation for WebSocket CSRF protection
- Contract-derived client SDK (`actorClient(contract)`), React hooks (`actorContext(contract)`), test harness (`testActor(contract)`), and DO-to-DO refs (`createRef(contract)`)
- Sync-only message handlers with Immer `produce()` for state mutations
- Transactional side effects via `emit()` → SQLite outbox
- Sequential and parallel state machines
- Durable timers via `after` and `tick` handlers
