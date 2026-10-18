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
| `createActorKitContext<typeof machine>("room")` | `actorContext(Contract)`. Hooks: `useClient({ path, initialView })`, `useView`, `useSelector`, `useSend`, `useRole`, `useConnectionState`. |
| `createActorKitClient({ host, actorType, actorId, accessToken, checksum, initialSnapshot })` | `actorClient(Contract).create({ path, host, initialView, getToken })` or `createActorClient(...)`. Reconnect, heartbeat and resync are built in. |
| `ActorKitEnv`, `ACTOR_KIT_SECRET` | Your own `Env`; an optional `env` Zod schema on the actor types `ctx.env` (ADR-016). |
| Tests: `createActor(roomMachine, { clock: new SimulatedClock(), input })` | `testActor(Contract)` for one transition at a time, or `simulate({ contracts, now })` with `sim.advance("5s")` for whole games on a virtual clock (timers fire). |

## 3. The room, step by step (little-vigilante)

1. **State.** Keep `server` as your state: `{ tvId, seats, match, tvAway, seed }`. `public` and
   `private` become views.
2. **Input.** `input: RoomInputPropsSchema` plus `init: (input) => ({ … })`. The TV caller came from
   `input.caller.id` in 0.52; pass it in the input (`{ tvId }`), since `init` has no caller.
3. **Roles.** In order, first match wins:
   `system: (_, __, { callerType }) => callerType === "service"`,
   `tv: (s, c) => c === s.tvId`, `player: (s, c) => s.seats.some(x => x.id === c)`,
   `guest: () => true` (a phone not yet seated can only send `JOIN` / `OGS_JOIN`).
4. **Messages.** Each XState event with its action becomes one `message()`. Guards move into
   `guard`. A shared "for this seat" helper (`forSeat`) stays a plain function that handlers call
   with `ctx.caller`.
5. **The clock.** The `tick` delay becomes a timer the handlers reschedule:
   `ctx.schedule("tick", { in: tickDelay(state, ctx.now()), key: "tick" })` at the end of every
   handler that can move a deadline, and in the tick handler itself. `RESUME` goes away.
6. **Views.** `tv: view.shared(TvView, s => publicView(s))`,
   `player: view.perCaller(PlayerView, (s, c) => playerView(s, c))`. Write the view schemas with
   `schema({ … })` from `@actor-kit/core` so frames are binary. `nullable(...)`, `array(...)`,
   `record(...)`, `union(...)` and `json(zod)` cover most game views.
7. **The OGS join.** 0.52 games override `webSocketMessage` to verify an OGS token before the event
   reaches the machine. In 0.3, verify it in the Worker, then deliver the result as a service message
   (`stub.send("worker", "service", { type: "ADMIT", … })`) that only the `system` role may send.
   Codebreakers does this (`src/worker.ts`).
8. **Worker.** Replace `createActorKitRouter` with your `/api/<code>/ws` route: check the caller
   (signed id, OGS token), then `stub.fetch(withCallerIdentity(req, { callerId, callerType: "user",
   supportsBinary: true }))`. **Pass `supportsBinary: true`**, or every phone gets JSON frames
   despite the binary schemas.
9. **wrangler.toml.** The Durable Object class changes. Add a migration with
   `new_sqlite_classes = ["<NewClass>"]`, and keep the old class exported as a placeholder if
   `wrangler rollback` should still work (see upgrading-0.3 "A new Durable Object class blocks
   `wrangler rollback`"). Rooms are short-lived, so old rooms are not migrated.
10. **Client.** Pages boot from the Worker's `getSnapshot()` as before. Hand `initialView` and a
    `path` to `useClient`, and delete hand-rolled reconnect, ping and visibility code.

## 4. Tests

- Tests above the machine (the rules in `src/game/*`, URL helpers, OGS join parsing, seam and e2e
  tests that drive pages) carry over **unchanged**. Keep them unedited: they are the check that the
  migration changed nothing.
- Tests that drove the XState actor (`room.machine.test.ts` through `test/room-test-helpers.ts`) are
  tied to XState. Keep each test's body. Rewrite only the helpers (`createTestRoom`, `send`,
  `advance`, `view`, `player`) over `simulate()`:

  ```ts
  // Before (0.52): an XState actor on a SimulatedClock
  const actor = createActor(roomMachine, { clock: sim, input });
  actor.send({ type: "JOIN", name, caller: { type: "client", id }, env, storage });
  // After (0.3): the same helpers over simulate()
  const sim = simulate({ contracts: [RoomContract], now: START });
  const room = await sim.spawn(RoomContract, "ABCD", { tvId: TV });
  room.send(id, { type: "JOIN", name });
  sim.advance(ms);                    // timers fire in order on the virtual clock
  room.view(id);                      // what that caller's screen shows
  ```

  If a test's body has to change, it was testing XState, not the game. Say so in the commit.

## 5. Checklist

- [ ] `actor-kit`, `xstate` (if unused elsewhere) and the 0.52 patch are gone; every `@actor-kit/*` tarball is pinned in `pnpm.overrides`
- [ ] No `Date.now()` / `Math.random()` in handlers (`ctx.now()` / `ctx.random()`)
- [ ] `withCallerIdentity(..., { supportsBinary: true })`, and React contexts made with `actorContext(Contract)` (the contract value, not only its type) so `useClient` can decode binary
- [ ] Timers rescheduled by key; no `RESUME` handler
- [ ] wrangler migration for the new class
- [ ] Unit tests (rules) unchanged and green; machine-test helpers rewritten over `simulate()`
- [ ] Seam tests (real Worker) green: reconnect, a phone that slept, two tabs, the OGS join

## 6. Worked example: codebreakers (0.0.1 → 0.3)

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
`fetch failed`).

## 7. What a codemod can and cannot do

`scripts/migrate-from-0.52.mts` does the mechanical part and lists the rest:

```bash
scripts/vendor.sh /tmp/ak                                          # in actor-kit: build the tarballs
node scripts/migrate-from-0.52.mts ~/src/<game> /tmp/ak --dry      # the plan; writes nothing
node scripts/migrate-from-0.52.mts ~/src/<game> /tmp/ak            # do it
```

- **What it does.** Swaps `actor-kit` for the `@actor-kit/*` tarballs (react and test only if
  imported) and pins every one in `pnpm.overrides`. Deletes `patches/actor-kit@*.patch` and its
  `patchedDependencies` entry. Copies the tarballs to `vendor/actor-kit/`. Moves import paths
  (`actor-kit/worker` → `@actor-kit/worker`, `actor-kit/react` → `@actor-kit/react`,
  `actor-kit/server` → `@actor-kit/worker/token`, `actor-kit/test`, `actor-kit/storybook`). Renames
  `createAccessToken({ signingKey })` to `{ secret }`.
- **What it lists for a person.** Every line that uses a 0.52 symbol (`createMachineServer`,
  `createActorKitRouter`, `createActorKitContext`, `WithActorKitEvent`, `ActorKitEnv`, `Caller`, …),
  every `xstate` import and every bare `"actor-kit"` import, each with a hint pointing into this
  guide. For little-vigilante that's 28 lines in 7 files, nearly all in the machine, its types and
  its test helpers.
- **What it can't do.** Rewrite the machine. Events, guards and actions map one to one (§2), but
  `always`, `after` and `reenter`, and the `public`/`private` split, need a person who knows the game.
