# @actor-kit/storybook

## 0.2.0

First v2 pre-release, published under the `next` tag.

### Minor Changes

- e2988d8: Initial v0.1.0 release of Actor Kit.

  Actors on the edge — each actor is a Cloudflare Durable Object with a mailbox, private state, and behavior you define. Binary state sync with per-client views.

  Key features:
  - `defineActor()` + `createActorClass()` for typed actor definitions with contracts
  - Flat messages with role-based guards for authorization
  - Binary-first sync with `schema()` builder, delta encoding, and per-role views
  - Worker-trust auth model via `withCallerIdentity()` (JWT auth available as opt-in)
  - Contract-derived client SDK (`actorClient(contract)`), React hooks (`actorContext(contract)`), test harness (`testActor(contract)`), and DO-to-DO refs (`createRef(contract)`)
  - Sync-only message handlers with Immer `produce()` for state mutations
  - Transactional side effects via `emit()` → SQLite outbox
  - Sequential and parallel state machines
  - Durable timers via `after` and `tick` handlers

### Patch Changes

- 60e1b11: - Zod 4: `message()` infers the payload from the schema's output; empty payloads (`z.object({})`) type as `{ type: K }`. New shared `ContractMessages` / `MessageEvent` types in `@actor-kit/core`.
  - Client: `client.role` is seeded from `initialView.role`, so role-branching UIs render the correct branch during SSR.
  - Studio: live updates survive Durable Object hibernation; connections show role and connected time; manual connect is always available.
  - Storybook: peer range now includes `@storybook/react` 10.
- Updated dependencies [e2988d8]
- Updated dependencies [60e1b11]
  - @actor-kit/client@1.0.0
  - @actor-kit/react@1.0.0
