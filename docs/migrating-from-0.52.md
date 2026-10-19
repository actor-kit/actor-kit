# Migrating a game from actor-kit 0.52 to @actor-kit (0.3)

For a game on npm `actor-kit@0.52.6`, usually with `patches/actor-kit@0.52.6.patch`. That's most OGS
cast party games: bake-shop, bobberbrook, little-vigilante, rocket-crew, night-flight-owls,
story-nook, peekaboo-garden, midnight-museum, pocket-draft, silk-and-stone. The examples below are
little-vigilante's room.

0.52 served an **XState machine** from a Durable Object. 0.3 serves a **contract**: roles,
messages with Zod payloads, plain reducer handlers, durable timers and binary views. The game's
rules (pure functions over your own state) carry over unchanged. What you rewrite is the
machine around them: usually one file of 100–250 lines, plus its test helpers.

Read [upgrading-0.3.md](upgrading-0.3.md) for changes inside 0.3 pre-releases. This guide only
covers coming from 0.52.

## 1. Packages

```diff
 "dependencies": {
-  "actor-kit": "0.52.6",
-  "xstate": "^5.x",            // only if nothing else uses it
+  "@actor-kit/core":   "file:vendor/actor-kit/actor-kit-core-0.3.0-next.0-<sha>.tgz",
+  "@actor-kit/worker": "file:vendor/actor-kit/actor-kit-worker-0.3.0-next.0-<sha>.tgz",
+  "@actor-kit/client": "file:vendor/actor-kit/actor-kit-client-0.3.0-next.0-<sha>.tgz",
+  "@actor-kit/react":  "file:vendor/actor-kit/actor-kit-react-0.3.0-next.0-<sha>.tgz",
+  "jose": "^6"                 // only if the Worker signs or reads actor-kit tokens
 },
 "devDependencies": {
+  "@actor-kit/test":   "file:vendor/actor-kit/actor-kit-test-0.3.0-next.0-<sha>.tgz"
 },
 "pnpm": {
-  "patchedDependencies": { "actor-kit@0.52.6": "patches/actor-kit@0.52.6.patch" },
+  "overrides": { "@actor-kit/core": "file:...", "@actor-kit/worker": "file:...", "@actor-kit/client": "file:..." }
 }
```

- Make the tarballs with `scripts/vendor.sh <game>/vendor/actor-kit` from a clean actor-kit
  checkout ([vendoring.md](vendoring.md)), and pin every actor-kit package in `pnpm.overrides`.
- **Delete `patches/actor-kit@0.52.6.patch`.** It made `webSocketClose` answer with a sendable close
  code instead of echoing a reserved one (1005/1006/1015). 0.3 does that itself
  (`runtime/close-code.ts`, `answerClose`).
- Upgrade the client and the Worker together. The 0.3 client pings (`__ping`, ADR-020), and only a 0.3
  actor answers that.

## 2. Concept map

| 0.52 | 0.3 |
|---|---|
| `createMachineServer({ machine, schemas: { clientEvent, serviceEvent, inputProps }, options: { persisted: true } })` | `defineActor(name, { input, init, roles, messages, views, timers })` (or `setup({...}).actor(...)`), then `createActorClass(contract)`. State always persists. |
| `context: { public, private: Record<id, …>, server }` | One state of your own shape. `views` project it per role: `view.shared(schema, state => …)` for what everyone in a role sees, and `view.perCaller(schema, (state, caller) => …)` for a hand of cards. |
| `public`/`private` written by an action (often a `withViews()` helper) | Delete `withViews()`. Views are computed from state after each transition, and binary deltas carry only the changed fields. |
| `event.caller = { id, type: "client" \| "service" \| "system" }` | `ctx.caller` (a string) and `ctx.callerType` (`"user"` \| `"service"`) |
| `RoomClientEventSchema` / `RoomServiceEventSchema` (discriminated unions) | One `message(zodPayload, handler)` per event type in `messages`. The union is gone; each payload is parsed before its handler runs. |
| `guards` (`fromHost`, `fromTv`) | A role (`roles: { tv: (s, caller) => caller === s.tvId, … }`) plus `message(schema, { roles: ["tv"], handler })` for who may send it (others are refused `wrong_role`), or `message(schema, { guard: (state, payload, ctx) => …, handler })` for a check on state. |
| `assign(({ context, event }) => …)` | `handler: (state, payload, ctx) => nextState`: return the next state (or the same object for "no change"). |
| `on` / `states` / `always` | Flat `messages` plus your own `phase` field. Or use 0.3's `states` (ADR-017/019) when the phases have their own messages and timers. An `always` guard becomes a check at the end of the handler that changed the phase. |
| `after: { tick: … }` with `delays`, re-armed by `reenter: true` | `timers: { tick: timer(z.object({}).optional(), handler) }` and `ctx.schedule("tick", { in: ms, key: "tick" })`. A timer is a durable row plus an alarm. Scheduling the same `key` again replaces it, which is the "re-arm". |
| `RESUME` system event after a restart (re-arm lost XState timers) | Delete it. Timers survive eviction and restart. A deadline that passed while the room was asleep fires on wake, with `ctx.lateBy`. |
| `clock.now()`, `Date.now()`, `Math.random()` in actions | `ctx.now()`, `ctx.random()`, `ctx.id()`. They are recorded in the journal, so `replayJournal()` reproduces a room exactly. A determinism guard flags direct `Date.now()` calls. |
| `createActorKitRouter(["room"])` | Your own Worker route. Authenticate the caller, then `stub.fetch(withCallerIdentity(req, { callerId, callerType: "user", supportsBinary: true }))` |
| `createAccessToken({ signingKey, actorId, actorType, callerId, callerType })` (`actor-kit/server`) | `createAccessToken({ secret, actorId, actorType, callerId, callerType })` from `@actor-kit/worker/token` (`signingKey` is now `secret`), and `getCallerFromToken` to verify. A Worker that signs its own ids needs neither. |
| `stub.spawn({ actorType, actorId, caller, input })` | `stub.spawn({ actorId, caller, callerType, input })` |
| `stub.getSnapshot(caller)` → `{ checksum, snapshot }` | `stub.getSnapshot(caller, callerType)` → `{ checksum, snapshot, role }` |
| `createActorKitContext<typeof machine>("room")` | `actorContext(Contract)`. Hooks: `useClient({ path, initialView })` (creates the client), `useView`, `useSelector`, `useSend`, `useRole`, `useConnectionState`. |
| `RoomContext.useClient()` (no argument: the Provider's client) and `client.getState()` | `RoomContext.useActorClient()` and `client.view`. `client.subscribe(fn)` is the same. |
| `createActorKitClient({ host, actorType, actorId, accessToken, checksum, initialSnapshot })` | `actorClient(Contract).create({ path, host, initialView, getToken })` or `createActorClient(...)`. Reconnect, heartbeat and resync are built in. |
| `ActorKitEnv`, `ACTOR_KIT_SECRET` | Your own `Env`; an optional `env` Zod schema on the actor types `ctx.env` (ADR-016). |
| Tests: `createActor(roomMachine, { clock: new SimulatedClock(), input })` | `testActor(Contract)` for one transition at a time, or `simulate({ contracts, now })` with `sim.advance("5s")` for whole games on a virtual clock (timers fire). |

## 3. The room, step by step (little-vigilante)

Done for real on little-vigilante (branch `claude/actor-kit-2-migration` in its repo): its 210-line
machine became `src/room.actor.ts`, about 280 lines, over the unchanged `src/game/*` rules.

1. **State.** The machine's `server` context becomes the state (`{ tvId, seats, match, tvAway, seed }`),
   plus `roomCode` and `updatedAt` (step 6). `public` and `private` become views; `withViews()` goes.
2. **Input.** `input: z.object({ roomCode, tvId, seed? })` plus `init`. 0.52 took the TV from
   `input.caller.id` and the code from `input.id`; `init` has neither, so the Worker passes both.
3. **Roles.** In order, first match wins:
   `system: (_, __, { callerType }) => callerType === "service"`,
   `tv: (s, c) => c === s.tvId`, `player: (s, c) => s.seats.some(x => x.id === c)`, and a catch-all
   `guest: () => true` for a phone that has not joined yet.
4. **Messages.** Each event becomes one `message()` whose payload is the event schema without its
   type: export each event schema by name and pass `JoinEventSchema.omit({ type: true })` (picking
   members out of a `discriminatedUnion` loses their types). The machine's per-state `on` becomes a
   `guard` on the phase (`CONFIGURE` and `START` only in the lobby, `NEXT` only while playing), and
   `fromTv` becomes `roles: ["tv"]`. A refused message (failed guard or wrong role) changes nothing,
   as before; the phone also gets an `__error` frame now. Helpers like `forSeat` stay plain functions
   that handlers call with `ctx.caller`.
5. **The clock.** `after: { tick }` becomes a timer the handlers re-arm:
   `ctx.schedule("tick", { in: tickDelay(state, ctx.now()), key: "tick" })` wherever the machine
   re-entered `playing` (`reenter: true`), and in the tick handler itself; `ctx.cancel("tick")` back
   in the lobby. `RESUME` goes away. Seeds come from `ctx.random()`, never `Math.random()`.
6. **Views.** A view can't read the clock (views are pure functions of state). A `serverNow` that
   0.52 stamped in `withViews(context, clock.now())` becomes `updatedAt: ctx.now()` set by every
   change, and the view reads that. **Keep the 0.52 snapshot's shape** and the client code stays as
   it is: one `screen(state, caller)` returning `{ public, private, value }`, with
   `schema({ public: json(PublicZ), private: json(PrivateZ), value: json(ValueZ) })` and
   `view.perCaller(ScreenView, screen)` for every role. (little-vigilante: 110 `useSelector` calls,
   none changed.) Smaller binary frames, with field schemas instead of `json()`, can come later.
7. **The OGS join.** 0.52 games override `webSocketMessage` to verify an OGS token before the event
   reaches the machine. The Worker never sees socket messages in 0.3, so the check moves inside the
   room as a **service**: `JOIN` with an `ogsToken` calls `ctx.execute("verifyOgs", { caller, token,
   name })`, the service's `fn` verifies (it gets the env), and `onDone` seats the phone. Two catches:
   a service callback gets `(state, result: unknown, input: unknown, ctx)`, so parse both with zod;
   and its `ctx` has only `now` / `id` / `random` (no timers). Keep a `system`-only `OGS_JOIN` message
   for tests and other server-side callers.
8. **Worker.** Replace `createActorKitRouter` with your own `/api/room/<code>` route. Keep the page's
   actor-kit token: `getTokenFromRequest(req)` reads it from the socket's protocol header,
   `getCallerFromToken(token, "room", code, secret)` checks it, then
   `stub.fetch(withCallerIdentity(req, { callerId: caller.caller, callerType: caller.callerType }))`.
   `stub.spawn({ actorId, caller, callerType: "user", input })` and `stub.getSnapshot(caller, "user")`
   take the caller as a string now. A spawn of an existing room is refused (catch it where a reload
   can spawn again). Pass `supportsBinary: true` once the views have field schemas and the client
   decodes them (§6 in codebreakers).
9. **wrangler.toml.** If the 0.52 class was already a SQLite class (`new_sqlite_classes`, as
   little-vigilante's `Room`), keep its name: no migration. Rooms persisted by 0.52 won't load (no
   actor-kit tables), which is fine for short-lived rooms. A KV-backed class needs a new class
   name and a migration (upgrading-0.3, "A new Durable Object class blocks `wrangler rollback`").
10. **Client.** `actorContext<typeof RoomContract>()` with `import type`, so zod, the rules and the
    OGS check stay out of the page bundle. Boot mounts `RoomContext.useClient({ path, host,
    initialView, getToken: () => boot.accessToken })` and its Provider. The typed view carries a
    `role` tag (`LinkedView`), so `initialView` is `{ role, ...snapshot }` with the role from
    `getSnapshot()`. Delete hand-rolled reconnect, ping and visibility code.

### A shortcut for big machines: keep the context as the state (story-nook)

When the machine keeps state in `public` itself (story-nook's `paused`, `length` and effect counters)
or has many guards and actions, translating handler by handler is risky. Instead:

- **The state is the machine's context.** `{ public, private, server }`, still re-projected by
  `withViews()` after every change. The view is
  `{ public: state.public, private: state.private[caller] ?? {}, value: state.server.phase }`. Mirror
  the machine's state value into the context if it doesn't already (story-nook kept it in
  `server.phase`).
- **Guards and actions stay as they are.** Copy them out of `setup({ guards, actions })` into plain
  objects (an identity `assign` keeps the bodies unchanged), with `({ context, event })` built from
  `(state, payload, ctx)`.
- **The transitions become a table.** For each event: its transitions in order, under `any` for the
  root `on` or under the phase for `states.<phase>.on`. A small `step()` takes the first transition
  whose guard holds, runs its actions, then the target's entry actions. An `after` becomes a timer
  that entry schedules.
- **Thread `ctx.now()` / `ctx.id()` / `ctx.random()` into the actions** that called `Date.now()`,
  `crypto.randomUUID()` or `crypto.getRandomValues()`.

story-nook's 466-line machine became `src/room.actor.ts` this way. All of its tests passed unedited,
including whole stories read through the helpers.

**Nested states (bake-shop).** A machine with child states (`day.baking.ovenGolden`), `always` and
guarded `after` needs a little more than a flat table:

- Keep the active **leaf** in `server.phase`, with a `PARENT` map and each parent's `INITIAL` child, and
  rebuild the state value from the leaf for the view (`{ day: { baking: "ovenGolden" } }`).
- Pick a transition the way XState did: the leaf's `on` first, then each parent's, then the root's.
- Taking it: exit actions from the leaf up to the deepest state source and target share (for a
  `reenter: true` self-transition, the source's parent), then the transition's actions, then entry
  actions down to the target's initial leaf.
- Each timed state's `after` is one durable timer, key `"after"`, payload the leaf it was armed for.
  Entering a timed leaf schedules it (the same key replaces any older one); entering an untimed leaf
  cancels it; the handler ignores a payload whose leaf the room has left. A guarded `after` whose guard
  fails just lapses, as in XState (bake-shop re-enters the oven state on un-pause to re-arm it).
- After every step, check the `always` of each active state.
- **`Math.random()` in the machine's `context` factory**: `init` has no `ctx.random()`. Make the seed
  part of the input and have the Worker roll it (`crypto.getRandomValues`) when the page names none.

## 4. Tests

- Tests above the machine (the rules in `src/game/*`, URL helpers, OGS join parsing) carry over
  **unchanged**, and so do seam tests that drive pages. Keep them unedited: they are the check that
  the migration changed nothing.
- Tests that drove the XState actor (`room.machine.test.ts` through `test/room-test-helpers.ts`)
  also stay unedited. Rewrite only the helpers, keeping their names and signatures, over
  `simulate()`. Little-vigilante's 30 machine tests passed this way unchanged:

  ```ts
  // Before (0.52): an XState actor on a SimulatedClock
  const actor = createActor(roomMachine, { clock: sim, input });
  actor.send({ type: "JOIN", name, caller: { type: "client", id }, env, storage });
  // After (0.3): the same helpers over simulate()
  const sim = simulate({ contracts: [RoomContract], now: START });
  const actor = sim.spawnSync(RoomContract, "ABCD", { roomCode: "ABCD", tvId });
  actor.send(id, { type: "JOIN", name });
  sim.advance("250ms");               // timers fire in order on the virtual clock
  ScreenSchema.parse(actor.view(id)); // what that caller's screen shows (parsed: views are data)
  ```

  - `snap(room).value` becomes the view's `value`.
  - A helper that sent a server-made event (OGS_JOIN) sends it as the `system` role:
    `actor.send("worker", { type: "OGS_JOIN", id, profile }, { callerType: "service" })`.
  - `restart()` and `sendSystem("RESUME")` become no-ops, each with a comment: 0.3 restores state
    and timers itself, and actor-kit's own tests cover the restore.
  - Helpers can keep the XState snapshot's shape where tests read it: `actor.getSnapshot()` as
    `{ value, context: state }` and `clock.increment(ms)` as `sim.advance(...)` (story-nook).
  - A test of a Durable Object restart (`getPersistedSnapshot()`, a new actor, `RESUME`) becomes
    `room.sim.branch()`: a copy of the state and its pending timers, which is what a restarted room
    has (bake-shop's `room.resume.test.ts`, same names and assertions).
  - In-page rooms (a TV preview, scenario tests) that used `actor.subscribe` and `clock.increment`:
    `simulate()` has no subscribe, so wrap `send` and `advance` and tell listeners when `actor.state`
    changed (bake-shop's `src/game/memoryRoom.ts`). `@actor-kit/test` runs in the browser.
  - Each `simulate()` starts from the same seed. Tests that compare two rooms ("books get fresh ids")
    need `simulate({ seed })` with a seed per room, as production rooms each draw their own.
- **Seam-test helpers on 0.52's client** (an `e2e/wire.ts` with `createActorKitClient`): keep their
  surface (`send`, `getState`, `waitFor`, `disconnect`) over `createActorClient`, and the tests stay
  unedited. A test file that imports `actor-kit/browser` or `xstate` itself can't stay unedited; ask
  before changing it (bake-shop).

  If a test's body has to change, it was testing XState, not the game. Say so in the commit.

## 5. Checklist

- [ ] `actor-kit`, `xstate` (if unused elsewhere) and the 0.52 patch are gone; every `@actor-kit/*` tarball is pinned in `pnpm.overrides`
- [ ] No `Date.now()` / `Math.random()` in handlers (`ctx.now()` / `ctx.random()`)
- [ ] `withCallerIdentity(..., { supportsBinary: true })`, and React contexts made with `actorContext(Contract)` (the contract value, not only its type) so `useClient` can decode binary
- [ ] Timers rescheduled by key; no `RESUME` handler
- [ ] wrangler migration for the new class
- [ ] Unit tests (rules) unchanged and green; machine-test helpers rewritten over `simulate()`
- [ ] Seam tests (real Worker) green: reconnect, a phone that slept, two tabs, the OGS join

## 6. Worked examples

**little-vigilante (0.52.6 → 0.3), the full migration** (§3; branch `claude/actor-kit-2-migration`):

- The codemod (§7), then the contract, Worker route, two client files and the test helpers, by hand.
- Typecheck green. All 204 unit tests green, none edited, including the 30 machine tests through the new helpers.
- Seam tests (wrangler dev, real browsers, OGS tokens): 16 of 17 in a full run. Every test passed in
  at least one run; the failures were bug-bash games timing out at load average 150–200, as on the
  0.52 baseline.
- An OGS-profile join test that failed twice on 0.52 in the same setup passes on 0.3.
- First real use found three codemod bugs, now fixed: it scrambled package.json's key order, left
  out `@actor-kit/test`, and copied every tarball instead of the pinned ones.
- It also showed that token signing needs `jose`, and (then) that zod 3 games had to move to zod 4;
  the codemod does both. Since ADR-024 a game may stay on zod 3.25 instead (see §1).

**codebreakers (0.0.1 → 0.3)**, the 0.3 end state:


Codebreakers was already a contract (`defineActor`, `message`, `view.shared` / `view.perCaller`,
`createActorClass`, `actorContext`, `testActor`) on an early vendored build (`@actor-kit/*` 0.0.1).
That's where a 0.52 game is after step 3, which makes it the end-to-end check of §1 and §4
(branch `claude/actor-kit-2-migration` in codebreakers):

1. Tarballs swapped and all five pinned in `pnpm.overrides`. **No source change**: typecheck, 125
   unit tests and 11 seam tests (TV and 4 phones through a whole game, a refresh mid-game, OGS phone
   and TV in the app) passed unedited.
2. `supportsBinary: true` added in the socket route. This exposed an actor-kit bug:
   `actorContext(Contract).useClient` ignored the contract, so React screens could not decode binary
   frames and stayed on their first view. Fixed upstream (`0075f2c`). With it, the same 11 seam tests
   pass on binary frames.

Running a game's seam tests from a fresh git worktree needs the gitignored local files: copy
`.dev.vars` and create `.wrangler/`, or wrangler dev never starts (every test then fails with
`fetch failed`). A game with no `.dev.vars` needs `--var ACTOR_KIT_SECRET:<a throwaway value>` on its
local wrangler dev, or every page that signs a token returns 500.

**story-nook (0.52.6 → 0.3)**, with the context-as-state shortcut (§3); merged to its main:

- `src/room.actor.ts` keeps the machine. `room.server.ts` subclasses `createActorClass(RoomContract)`
  to add try-kit's room life (`life`, `claim`, `markOpened`, and the `fetch` / `webSocketClose`
  hooks). The Worker calls `markOpened()` after a TV spawns the room, since the subclass can't see
  actor-kit's storage.
- `e2e/wire.ts` keeps 0.52's client surface over `createActorClient`. Three client files moved from
  `useClient()` / `getState()` to `useActorClient()` / `view`.
- None of the tests edited. Typecheck, 392 unit tests, CRAP < 8, 10 seam tests, 4 try-path tests and a
  local try-path load run all green.
- Two actor-kit bugs found and fixed:
  - React had no hook for the Provider's client; `useActorClient()` is new.
  - A child's mount-time `send` was dropped because `useClient` connected after children's effects;
    it now connects in a layout effect.
- One more codemod fix: React detection also counts an import already moved to `@actor-kit/react`.

## 7. What a codemod can and cannot do

`scripts/migrate-from-0.52.mts` does the mechanical part and lists the rest:

```bash
scripts/vendor.sh /tmp/ak                                          # in actor-kit: build the tarballs
node scripts/migrate-from-0.52.mts ~/src/<game> /tmp/ak --dry      # the plan; writes nothing
node scripts/migrate-from-0.52.mts ~/src/<game> /tmp/ak            # do it
```

- **What it does.** Swaps `actor-kit` for the `@actor-kit/*` tarballs: core, worker and client,
  react if imported, and always test (for the `simulate()` helpers, §4). It pins every one in
  `pnpm.overrides` and keeps package.json's key order. It moves zod 3 to `^4.6.5`, and adds `jose`
  if the game calls `createAccessToken`. It deletes `patches/actor-kit@*.patch` and its
  `patchedDependencies` entry, and copies only the pinned tarballs to `vendor/actor-kit/`. Moves import paths
  (`actor-kit/worker` → `@actor-kit/worker`, `actor-kit/react` → `@actor-kit/react`,
  `actor-kit/server` → `@actor-kit/worker/token`, `actor-kit/test`, `actor-kit/storybook`). Renames
  `createAccessToken({ signingKey })` to `{ secret }`.
- **What it lists for a person.** Every line that uses a 0.52 symbol (`createMachineServer`,
  `createActorKitRouter`, `createActorKitContext`, `WithActorKitEvent`, `ActorKitEnv`, `Caller`, …),
  every `xstate` import and every bare `"actor-kit"` import, each with a hint pointing into this
  guide. For little-vigilante that's 28 lines in 7 files, nearly all in the machine, its types and
  its test helpers; the hand-written part of its migration took the contract, the Worker route, two
  client files and the helpers (§6).
- **What it can't do.** Rewrite the machine. Events, guards and actions map one to one (§2), but
  `always`, `after` and `reenter`, and the `public`/`private` split, need a person who knows the game.
