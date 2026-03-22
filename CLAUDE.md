# Actor Kit v2

Actors on the edge. Each actor is a Cloudflare Durable Object with a mailbox, private state, and behavior you define. Binary state sync with per-client views. Built from the ground up for Cloudflare infrastructure.

## Stack

- **Language**: TypeScript (strict mode, no `any`, no `as` casts)
- **Runtime**: Cloudflare Workers + Durable Objects (SQLite storage)
- **Validation**: Zod (events + input), custom `schema()` builder (views + binary encoding)
- **State mutations**: Immer `produce()`
- **Auth**: JWT via `jose` library
- **Build**: tsdown (esbuild-based)
- **Test**: Vitest + `@cloudflare/vitest-pool-workers` for integration tests
- **Package manager**: pnpm
- **Monorepo**: pnpm workspaces

## Repo structure

Single published package (`actor-kit`) with subpath exports, plus internal dev packages:

```
actor-kit-2/
├── packages/
│   └── actor-kit/         → published as "actor-kit"
│       ├── src/
│       │   ├── core/      → actor(), schema(), view(), roles, messages
│       │   ├── runtime/   → DO class generation, WebSocket lifecycle, persistence
│       │   ├── schema/    → schema() builder, binary encoder/decoder, type primitives
│       │   ├── auth/      → JWT creation + validation
│       │   ├── client/    → connect(), subscribe, send, reconnection
│       │   ├── react/     → createContext(), useView(), useSend(), useRole()
│       │   └── test/      → testActor(), emission capture, view assertions
│       └── package.json   → subpath exports: ".", "./client", "./react", "./test"
├── tests/
│   ├── unit/              → Pure logic tests (no CF runtime)
│   └── integration/       → vitest-pool-workers (full DO lifecycle)
├── examples/
│   ├── counter/           → Minimal counter actor
│   └── todo/              → Full todo list with roles
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
4. `pnpm lint` — ESLint with no-explicit-any, no-non-null-assertion

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

4. **Deep CF integration** — Embrace Durable Objects: SQLite for persistence, Alarms for durable timers, RPC for actor-to-actor communication, Hibernation for idle actors. No abstraction layers that hide CF capabilities.

5. **Transactional side effects** — State changes persist atomically. Side effects go through `emit()` → SQLite outbox → at-least-once delivery. Async transitions are for effects that inform state. `emit()` is for fire-and-forget.

6. **Parse at the boundary** — All external data (events, input, WebSocket frames) is parsed through a schema before entering application logic. Invalid data is rejected, never coerced. See [docs/adrs/002-parse-at-boundary.md](docs/adrs/002-parse-at-boundary.md).

## Key conventions

### API surface

- **`actor(name, def)`** — single function defines an actor. Returns a DO class.
- **`schema({ field: type })`** — defines binary-encodable view shapes with TypeScript inference.
- **`view(Schema, fn)`** — pairs a schema with a projection function.
- **`ref(env, actorType, actorId)`** — gets a typed stub for DO-to-DO RPC.
- **`emit(type, payload)`** — queues a side effect in the transactional outbox.
- **`connect(actorType, opts)`** — client SDK, WebSocket connection with binary decoding.
- **`testActor(Actor)`** — test helper, runs transitions without CF runtime.

### Roles and authorization

- Roles are defined as `(state, caller) => boolean` predicates. First match wins (top-to-bottom).
- Caller is a plain string (extracted from JWT `sub` claim).
- No match = connection rejected (403). Every actor must have a catch-all role or explicitly reject unknowns.
- Role re-evaluated on every message (state changes can change your role).
- Messages are scoped per role. A role with `{}` is read-only.

### Events and messages

- Messages are defined per role in the `messages` block.
- Handler signature: `(state, payload, ctx) => state | Promise<state>`
- `ctx` contains `{ caller, role, env, emit }`.
- Zod validates message payloads at runtime. Invalid = rejected before handler.
- System events: `connect`, `disconnect`, `resume`, `emissionFailed` — in the `on` block.

### State and persistence

- State shape is inferred from `init()` return type.
- Always persisted to DO SQLite after each transition.
- Version-based migration: bump `version`, provide `migrate(persisted, fromVersion)`.
- Sequential migration: v1 → v3 runs migrate(v1→v2) then migrate(v2→v3).
- Custom `serialize`/`restore` for non-JSON-safe state (Maps, Sets, Dates).

### Schema and binary encoding

- Schema primitives: `uint8`, `uint16`, `uint32`, `float32`, `float64`, `string`, `boolean`.
- Combinators: `array(T)`, `schema({...})` for nesting. Phase 2 adds `map`, `optional`, `enum`.
- Schemas implement `StandardSchemaV1` interface for ecosystem interop.
- Delta frames use bitmask to indicate which fields changed.

### Auth

- JWT via `jose`. Claims: `jti` = actor ID, `aud` = actor type, `sub` = caller identity.
- Signing: HS256 with `ACTOR_KIT_SECRET` from Worker env.
- Token validated on WebSocket connect and on every HTTP request.

### Testing

- **Unit tests**: `testActor()` — pure transitions, no CF runtime. Fast, TDD-friendly.
- **Integration tests**: `vitest-pool-workers` — real DO, real WebSocket, real SQLite.
- **Fakes over mocks**: Use real implementations or fakes. Never mock internals.
- **Emission capture**: `sendWithEffects()` returns `{ state, emissions }` for asserting side effects.
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
