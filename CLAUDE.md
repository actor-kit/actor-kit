# Actor Kit v2

Actors on the edge. Each actor is a Cloudflare Durable Object with a mailbox, private state, and behavior you define. Binary state sync with per-client views. Built from the ground up for Cloudflare infrastructure.

## Stack

- **Language**: TypeScript (strict mode, no `any`, no `as` casts)
- **Runtime**: Cloudflare Workers + Durable Objects (SQLite storage)
- **Validation**: Zod (messages + input), custom `schema()` builder (views + binary encoding)
- **State mutations**: Immer `produce()`
- **Auth**: JWT via `jose` library
- **Build**: tsdown (esbuild-based)
- **Test**: Vitest + `@cloudflare/vitest-pool-workers` for integration tests
- **Package manager**: pnpm
- **Monorepo**: pnpm workspaces

## Repo structure

Six scoped packages under `@actor-kit/*`:

```
actor-kit-2/
├── packages/
│   ├── core/              → @actor-kit/core: schema(), view(), type primitives, encode/decode
│   ├── worker/            → @actor-kit/worker: defineActor(), createActorClass(), message(), withCallerIdentity()
│   ├── client/            → @actor-kit/client: actorClient(), WebSocket connection, binary decoding
│   ├── react/             → @actor-kit/react: actorContext(), useView(), useSend(), useRole()
│   ├── test/              → @actor-kit/test: testActor(), emission capture, view assertions
│   └── storybook/         → @actor-kit/storybook: withActorKit(), createMockClient()
├── tests/
│   ├── unit/              → Pure logic tests (no CF runtime)
│   └── integration/       → vitest-pool-workers (full DO lifecycle)
├── examples/
│   ├── counter/           → Minimal counter actor
│   ├── todo-list/         → Full todo list with roles
│   ├── chat-room/         → Real-time chat with lifecycle
│   ├── auction/           → Guards and competitive bidding
│   └── tanstack-start-counter/ → TanStack Start SSR + WebSocket
├── website/               → Docs site (Astro + Starlight)
├── docs/
│   ├── architecture.md    → System design, module boundaries, type system
│   ├── binary-protocol.md → Wire format, frame layout, delta encoding
│   ├── testing-strategy.md → Test pyramid, fakes, integration patterns
│   ├── specs/             → Feature specifications (TDD targets)
│   └── adrs/              → Architecture Decision Records
└── .changeset/
```

## Feedback commands

Run before committing:

1. `pnpm typecheck` — strict TypeScript, zero errors
2. `pnpm test:unit` — Vitest unit tests
3. `pnpm test:integration` — vitest-pool-workers (DO lifecycle, WebSocket, persistence)
4. `pnpm lint` — Biome: no-explicit-any, formatting, import ordering

## Knowledge base

Do NOT load all docs upfront. Load only when relevant to the current task.

| Topic | Location | When to load |
|-------|----------|-------------|
| System architecture | [docs/architecture.md](docs/architecture.md) | Changing core modules, understanding data flow |
| Binary wire protocol | [docs/binary-protocol.md](docs/binary-protocol.md) | Encoder/decoder work, frame layout, delta encoding |
| Testing strategy | [docs/testing-strategy.md](docs/testing-strategy.md) | Writing tests, choosing test level |
| Feature specs | [docs/specs/](docs/specs/) | Implementing a specific feature |
| Architecture decisions | [docs/adrs/](docs/adrs/) | Questioning a design choice, making a new one |

## Core principles

1. **Offensive type safety** — Types are a development accelerator, not a tax. Generics enforce alignment at compile time. Zod validates at runtime boundaries. No `any`. No `as` casts. No non-null assertions. If the compiler can't verify it, restructure until it can. See [docs/adrs/001-offensive-typesafety.md](docs/adrs/001-offensive-typesafety.md).

2. **Role-scoped everything** — Roles are derived from state. Messages are validated per role before reaching the handler. Views are projected per role. Authorization is structural, not coded in every handler.

3. **Binary-first sync** — `schema()` defines the binary wire format. Delta encoding sends only changed fields. Full snapshots only on first connect or schema mismatch. Minimize bytes over the wire.

4. **Deep CF integration** — Embrace Durable Objects: SQLite for persistence, Alarms for durable timers, RPC for actor-to-actor communication, Hibernation for idle actors, `ctx.exports` for single-Worker actor discovery (ADR-012). No abstraction layers that hide CF capabilities.

5. **Transactional side effects** — State changes persist atomically. Side effects are declared as `services` and invoked via `ctx.execute(serviceName, input)` → SQLite outbox → at-least-once delivery. Services define typed input/output with `onDone`/`onError` callbacks routed back to the actor's `on` block.

6. **Parse at the boundary** — All external data (events, input, WebSocket frames) is parsed through a schema before entering application logic. Invalid data is rejected, never coerced. See [docs/adrs/002-parse-at-boundary.md](docs/adrs/002-parse-at-boundary.md).

## Key conventions

### API surface

- **`actor<Env>(name, def)`** — single function defines an actor. Returns a DO class. `Env` is the only explicit generic (Worker env bindings).
- **`schema({ field: type })`** — defines binary-encodable view shapes with TypeScript inference.
- **`view.shared(Schema, fn)`** — pairs a schema with a state-only projection function. Cacheable across sockets in the same role.
- **`view.perCaller(Schema, fn)`** — pairs a schema with a projection that receives `(state, caller)`. Per-caller unique projections (e.g. card game hands).
- **`message(zodSchema, handler)`** or **`message(zodSchema, { guard, handler })`** — pairs a Zod payload schema with a handler. Optional guard rejects before handler runs. Required for all message and RPC handlers.
- **`ref(env, actorType, actorId)`** — gets a typed stub for DO-to-DO RPC. Also supports `createRef(contract, exports, env, actorId)` for `ctx.exports` discovery (ADR-012).
- **`resolveNamespace(contractName, exports, env)`** — finds a DO namespace by contract name from `ctx.exports`, falls back to env binding.
- **`ctx.execute(serviceName, input)`** — invokes a named service defined in the actor's `services` block. Services declare `fn`, optional `onDone`/`onError` handlers. Durable via outbox — persisted atomically with state, retried on crash.
- **`connect(actorType, opts)`** — client SDK, WebSocket connection with binary decoding.
- **`testActor(Actor)`** — test helper, runs transitions without CF runtime.

### Roles and authorization

- Roles are defined as `(state, caller, { callerType }) => boolean` predicates. First match wins (top-to-bottom).
- Caller is a plain string (extracted from JWT `sub` claim).
- No match = connection rejected (403). Every actor must have a catch-all role or explicitly reject unknowns.
- Role re-evaluated on every message (state changes can change your role).
- Messages are scoped per role. A role with `{}` is read-only.

### Messages

- Messages are defined in the `messages` block as flat handlers.
- All handlers use `message(zodSchema, handler)` or `message(zodSchema, { guard, handler })`.
- Handler signature: `(state, payload, ctx) => state`
- `ctx` contains `{ caller, callerType, role, env, execute }`.
- Zod validates message payloads at runtime. Guard evaluates after validation. Invalid/guarded = rejected before handler.
- Same message name across multiple roles must reference the same `MessageDef` object — enforced by the type system.
- `lifecycle` block handles `connect`/`disconnect` events.
- Actors are always separate DOs. No child actors in the same DO. Use `execute(serviceName, input)` for actor-to-actor communication via services.

### State and persistence

- State shape is inferred from `init()` return type.
- Always persisted to DO SQLite after each transition.
- Version-based migration: bump `version`, provide `migrate(persisted, fromVersion)`.
- Sequential migration: v1 → v3 runs migrate(v1→v2) then migrate(v2→v3).
- Custom `serialize`/`restore` for non-JSON-safe state (Maps, Sets, Dates).

### Schema and binary encoding

- Schema primitives: `uint8`, `uint16`, `uint32`, `float32`, `float64`, `string`, `boolean`.
- Combinators: `array(T)`, `schema({...})` for nesting, `nullable(T)` for fields that can be `null`.
- `nullable()` adds a null bitmask to the wire format (1 bit per nullable field). Zero overhead for non-nullable schemas.
- Schemas implement `StandardSchemaV1` interface for ecosystem interop.
- Delta frames use bitmask to indicate which fields changed. Nullable fields use a parallel null bitmask.

### Auth

- JWT via `jose`. Claims: `sub` = caller identity, `act` = callerType (`"user"` or `"service"`), `jti` = actor ID, `aud` = actor type.
- `callerType` is stable identity metadata from the token — not authorization. Roles handle authorization.
- Signing: HS256 with `ACTOR_KIT_SECRET` from Worker env.
- Token validated on WebSocket connect and on every HTTP request.

### Testing

- **Unit tests**: `testActor()` — pure transitions, no CF runtime. Fast, TDD-friendly.
- **Integration tests**: `vitest-pool-workers` — real DO, real WebSocket, real SQLite.
- **Fakes over mocks**: Use real implementations or fakes. Never mock internals.
- **Effect capture**: `send()` returns `{ state, executions, links, unlinks, forwards }` for asserting service invocations and actor-to-actor interactions.
- **TDD**: Red-green-refactor. Write the test first. See it fail. Implement. See it pass.

## Keeping docs current

| If you change... | Then update... |
|-----------------|----------------|
| Core types (`src/core/types.ts`) | [docs/architecture.md](docs/architecture.md) § Type System |
| Binary encoding (`src/schema/`) | [docs/binary-protocol.md](docs/binary-protocol.md) |
| DO runtime (`src/runtime/`) | [docs/architecture.md](docs/architecture.md) § Runtime |
| Test infrastructure | [docs/testing-strategy.md](docs/testing-strategy.md) |
| Any architectural decision | Create new ADR in [docs/adrs/](docs/adrs/) |

## Off-limits

- **JWT signing keys** — never log, never include in test output, never hardcode.
- **Pre-commit hooks** — never bypass with `--no-verify`.
- **`as` casts** — never. Restructure the types until the compiler is satisfied.
- **`any`** — never. Use `unknown` and narrow.
- **Existing passing tests** — never modify to make new code pass. If new code breaks existing tests, the new code is wrong.

## Git

- **Branch**: `main`
- **Hooks**: Pre-commit runs typecheck + test:unit
- **Versioning**: Changesets
- **Commits**: Conventional commits (`feat:`, `fix:`, `test:`, `docs:`)
