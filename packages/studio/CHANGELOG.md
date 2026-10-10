# @actor-kit/studio

## 0.2.0

First v2 pre-release, published under the `next` tag.

### Minor Changes

- 10fca44: Effect ids and outbox retries (ADR-015 D1).

  - Every execution and forward a transition declares is keyed `seq:index`: the transition's sequence number (the journal seq, or the snapshot's counter with `journal: false`) and the effect's position in that transition. The outbox sorts by (seq, index) as integers. Services get a third argument, `{ effectId, attempt }`, to use as an idempotency key; retries reuse the same id.
  - Services retry: `retry: { attempts, backoff: { baseMs, factor, maxMs, jitter } }`, default 3 tries 1s then 5s apart (±20%). Rows go `pending` → `running` → `done` | `retrying` (on the DO alarm) | `failed`. `onError` now runs only after the last try. `failed` rows are dead letters, logged once as an `actor_kit.outbox.failed` wide event.
  - The outbox `attempts` column now counts tries (it was always 0). Rows cut off mid-try by a crash run again on wake.
  - Redrive: Studio admins (mutate scope) can move a failed row back to `pending` under the same effect id (`POST /__studio/api/actors/:type/:id/actions` `{ action: "redrive", effectId }`, or the `__redrive` RPC). The Outbox panel shows the effect id, the next try and the last error, with a Redrive button on failed rows.

- 113a787: Restore (ADR-015 D3, ADR-013 step 3): `__restore({ toSeq })` (Studio action `restore`, mutate scope) appends a `restore` event and puts the actor back to journal seq `toSeq`: the state is folded from the newest checkpoint at or before it (checksum-verified), the timers pending then come back with their original deadlines, effects declared only by undone transitions become dead letters with the reason, and service results recorded after `toSeq` are redelivered as new events without calling the service. `foldJournal`/`replayJournal` replay restore events. Checkpoints store the pending timers; service journal events carry their `effectId`; timeline entries carry their journal `seq`, and Studio offers "Restore to here" on them. On wake, a snapshot that lags the journal is rebuilt from it.
- 186c0d7: Durable timers (ADR-015 D2): declare `timers: { name: timer(schema, handler) }`, schedule from message, lifecycle and timer handlers with `ctx.schedule(name, { in | at, key, payload })` and cancel with `ctx.cancel(key)`. Timers are persisted with their deadline in the same transaction as the state, share one Durable Object alarm with outbox retries, fire late ones in order with `ctx.lateBy`, each in its own transaction and journal event (`cause_type: "timer"`), and work with `journal: false`. Studio gets a Timers tab (name, key, due in, redacted payload) with an admin-only "Fire now". `testActor()` records `schedules` and `cancels`.
- e6dd16a: Typed, tagged service errors (ADR-016 §2).

  - A service may declare `errors` (a `z.discriminatedUnion("_tag", ...)`) and fail with `throw fail({ _tag, ... })` (`fail` from `@actor-kit/worker`). The runtime parses the value against `errors`; one that doesn't parse, or anything else thrown, is `{ _tag: "Defect", message }`. A try that runs out of time is `{ _tag: "Timeout", ms }`.
  - **Breaking:** `onError` receives that typed error instead of `{ message }` (a Defect keeps `message`). `defineActor` types it per service (declared errors plus the built-ins) and types `retry.while` the same way.
  - Default retry rule: the built-ins are retried, declared errors are not (a declined card fails at once and `onError` runs). `retry.while(error)` overrides it, for services and for link forwards.
  - The journal stores the parsed error, so replay and restore deliver the same value. The outbox keeps the error's tag (`last_error_tag`, migration `0014_last_error_tag`); Studio's Outbox shows it in the Last error column, and the `actor_kit.outbox.failed` event carries `errorTag`. A declared error's fields are redacted by `studio.redact` like payloads.
  - `simulate().reject(effect, error)` takes typed errors: declared ones are parsed against the service's `errors` (and refused when they don't parse), the built-ins are accepted, and a string or `{ message }` is a Defect.
  - Type tests (`tests/unit/*.types.test.ts`) are now checked by `pnpm typecheck` (`typecheck:types`).

- 9ecb99d: Domain events (ADR-017 §2).

  - Actors declare `events` (name → Zod schema). `ctx.emit(name, payload)` in message and timer handlers parses the payload and records the event; an undeclared name or invalid payload fails the transition.
  - `setup({ events })` returns `message()` / `timer()` helpers with `ctx.emit` typed by the declared events, and `events` for the actor definition.
  - Emitted events are stored on the journal row (`emitted`, migration `0017_emitted`); a transition that only emits is still journaled. `replayJournal()` fails with `JournalEmittedDivergenceError` at the first event that differs.
  - `testActor` returns `emitted`; `simulate()` exposes `sim.events()`. Studio's timeline shows each entry's events, redacted.
  - The auction example emits `BidPlaced`, `BidIgnored` and `AuctionClosed`.

- e8ebcda: One history (ADR-017 §5): Studio's timeline is read from the actor journal.

  - The `timeline` table and its writes are gone; migration `0015_drop_timeline` drops it. A timeline entry is a journal event (`id` = `seq`), its after-state taken from a checkpoint or replayed from the newest checkpoint before it, checksum-verified. An after-state that cannot be rebuilt (another code version, a pruned journal without a checkpoint before it, a diverging replay) is `null`; the UI says "State not available" and shows no diff, and the CLI shape reports no changed paths for it.
  - `studio.timelineSize` is removed: journal retention (`journal: { keep }`) is the only retention. With `journal: false` the timeline is empty.
  - Redaction is applied to the rebuilt entries through `runtime/studio-project.ts`, as before. Cursor pagination, live `studio.timeline` pushes and "restore to here" work as before.

- 3bf5148: States with typed locals (ADR-017 §1): optional `initial` + `states`. The persisted state is `{ shared, phase, local, stateTimers }`; handlers return `ctx.stay(shared, local?)`, `ctx.goto(phase, shared, input?)` or the shared state; exit drops the local and cancels `scope: "state"` timers; `enter` builds the next local. Messages are accepted only in their states plus top-level ones (`wrong_state` otherwise, before guards). `setup({ events, states })` and `quiz.in(phase)` give typed `local`, `stay`, `goto` and `enter`. `simulate()` and replay run them through the step core; Studio marks phase changes. New `examples/quiz` contract.
- d4a5e1e: Causation and correlation ids on every journal event (ADR-017 §4).

  - `events` gains `correlation_id` and `causation_id` (migration `0016_trace_ids`); `readJournal()` returns them as `correlationId` / `causationId` (absent on older rows).
  - A client or service message (and init, lifecycle, migrate, restore) starts a flow: its correlation id is its own id, `${actorType}/${actorId}/${seq}`, with no causation. Service results, timer firings and forwards received continue the declaring event's flow, caused by the effect (`${actorType}/${actorId}/${seq}:${index}`); link updates continue the source event's flow, caused by that event.
  - Forwards carry the flow to the target in a fourth `send()` argument; link pushes in a sixth `__receiveLinkUpdate()` argument. Both are parsed at the RPC boundary; anything else starts a new flow.
  - `simulate()` records the same ids. Studio shows an entry's flow and cause, linking to the causing event (in this actor, or another actor's timeline opened at it with `?entry=N`).

- acd6351: Forwards retry like executions: `link(Contract, { retry: { attempts, backoff } })` (default 3 tries), failed tries wait as `retrying` on the shared alarm, the last failure is a dead letter, and Studio's redrive takes forwards by effect id. Studio's Outbox lists forwards beside executions.
- 3fa386d: Studio production access (ADR-014). `/__studio` is authenticated with Cloudflare Access (SSO for people, one service token per agent); the `X-Actor-Kit-Studio-Key` header and `ACTOR_KIT_STUDIO_SECRET` are removed. Agents are read-only and see hashed callers (`STUDIO_CALLER_HASH_KEY`). Actors declare `studio: { redact: [...] }` path globs, applied in the Durable Object to everything Studio returns. Every Studio request emits a `studio.request` audit event. New `GET /__studio/api/actors/:type/:id/view` route, and the new `@actor-kit/studio-cli` package (`actor-kit studio list|types|inspect|timeline|view` and the `actor-kit-studio-mcp` server).

### Patch Changes

- 384a6ee: Studio: the Outbox and Links panels now update live. Actors push `studio.outbox` when an execution is added or settles and `studio.links` when links or subscribers change. Worker: a link subscriber now registers under its actor ID instead of its hex Durable Object ID, so the target's view updates reach it (before, they went to an empty actor named after the hex ID).
- 4881e32: Harden the Studio middleware: only `/__studio` and `/__studio/*` are intercepted; path and query params are parsed with Zod (400 on bad input instead of a thrown URIError or a 500); looking up an unknown actor is a 404 checked against the new `StudioRegistry.hasActor()` and never auto-spawns a phantom actor; unknown API routes are JSON 404s; non-GET/HEAD is 405; SPA deep links work for actor ids containing dots; error bodies are JSON. The embedded UI no longer ships stale build output (`emptyOutDir`).
- 4aed6a4: Studio UI: parse every WebSocket frame and API response with Zod and show malformed data as an error instead of crashing; reconnect with backoff without duplicating timeline entries; show readable 401/403/404/500/network error states (404 keeps polling until the actor exists); de-duplicate connections; race-safe dashboard search; dashboard pagination; studio key prompt on 401; manual connect validation; truncate very large JSON. Worker: live `studio.timeline` entries now include their row `id`, and `webSocketClose` answers the peer's close frame so browser sockets don't stay in CLOSING.
- 60e1b11: - Zod 4: `message()` infers the payload from the schema's output; empty payloads (`z.object({})`) type as `{ type: K }`. New shared `ContractMessages` / `MessageEvent` types in `@actor-kit/core`.
  - Client: `client.role` is seeded from `initialView.role`, so role-branching UIs render the correct branch during SSR.
  - Studio: live updates survive Durable Object hibernation; connections show role and connected time; manual connect is always available.
  - Storybook: peer range now includes `@storybook/react` 10.
- Updated dependencies [113a787]
- Updated dependencies [186c0d7]
- Updated dependencies [5feb791]
- Updated dependencies [9ecb99d]
- Updated dependencies [3bf5148]
- Updated dependencies [e2988d8]
- Updated dependencies [60e1b11]
  - @actor-kit/core@1.0.0
