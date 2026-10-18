# Hardening run (claude/harden-72e4ea, 2026-10-17)

Goal: make actor-kit rock-solid for the OGS cast party games: CRAP < 8 everywhere, Stryker
survivors killed, seam tests at the DO / WebSocket / client boundary (reconnect, suspend/resume,
stale snapshots: the "phone rewinds" bugs).

## Before (main at d881766)

| Gate | Value |
|---|---|
| CRAP, unit coverage (`scripts/crap.mts`, every package `src` + studio UI) | max 7.1 (`test`), 0 functions ≥ 8 |
| Mutation, full run (docs/quality.md, 2026-10-11, same production code) | core 99.81%, client 97.38%, react 94.34%, test 98.14%, storybook 100%, studio 99.20%, studio UI 94.98%, studio-cli 99.40%, worker 99.34%, projection 100% |
| Seam tests with the real client against a real actor | none |

## Findings (seam tests: `tests/integration/client-seam.test.ts`)

Held up already (green on first run): live order, own messages, a drop with changes while away,
a reconnect with nothing changed (checksum ack), sends while reconnecting, a restart closing every
socket, hibernation with sockets kept, the actor woken by the client's own message, two tabs of
one player.

Bugs found (each red before its fix):

| # | Bug | Effect in a game | Fix |
|---|---|---|---|
| 1 | A socket that dies without a close event (iOS froze the page, Wi-Fi changed) was kept forever; `visibilitychange` only skipped a backoff wait | iPad wakes and shows the room as it was when it slept; taps go nowhere | ADR-020 A/B: client heartbeat + probe on visible/online; actor auto-responds to pings without waking |
| 2 | `send()` dropped a message in the closing window (socket not open, close event not yet run) | a tap lost | ADR-020 C: queue whenever not `disconnected` |
| 3 | A frame that did not decode left the client one step behind until the next reconnect | stale view | ADR-020 D: resync with `__reconnect` |
| 4 | `parseFrame` accepted a frame shorter than its header said (subarray clamps): a cut-short delta decoded as "nothing changed" | stale view, no error | core: `invalid_frame` "Frame cut short" |
| 5 | React `useSelector` kept the old value when its selector changed or the Provider got another client, and missed a change between render and subscribe; `useRole` / `useConnectionState` the same | a screen behind the room | `useSyncExternalStore` |
| 6 | React `useView` rendered the old client's view once after a Provider swap | one frame of the previous room | `useView` renders the client's own view |
| 7 | React `useClient(options)` kept its first room's client for the life of the component | a screen moved to another room stays connected to the old one | one client per `host`+`path`; the old one is disconnected (React 97.01%, 2 equivalent) |
| 8 | After a phone's socket went half-open and the client reconnected, the actor kept the dead socket: a player who then left stayed online (chat example: onlineCount 2, expected 1) | ghost players, seats stay "connected" | ADR-020 E, opt-in `heartbeat: { staleMs }`: the actor closes sockets whose pings stopped and runs their disconnect (chat example opts in, 60 s). The `it.fails` is now three passing seam tests; red with the window set huge. Stryker `stale-sockets.ts` + `live-connections.ts` 100% (82/82) |
| 9 | When the heartbeat gave up on a dead socket, `close()` ran before the new socket bumped the generation: a socket whose close event fires at once (an adapter, some React Native / Node sockets) started a backoff retry next to the new socket, which then superseded it a second later | an extra socket and a reconnect cycle after every wake; the role-change-while-asleep seam test missed its 2 s window | the new socket opens first, then the dead one is closed (unit test red before: 4 sockets for 2) |

Bugs reported by consumers:

| # | Bug | Effect | Fix |
|---|---|---|---|
| C1 (Catancast) | A timer scheduled without a payload under `z.object({}).optional()` was stored as `null`; the DO parsed that against the schema at fire and dropped the timer, while `simulate()` handed the handler `null` unparsed | a bot game passed in simulate() and stalled in production | the step core parses the stored payload once at fire (`runtime/timer-payload.ts`, null read as absent when the schema rejects null); the timer row stores the payload as given. Found alongside: a schema with a transform could never fire (parsed at schedule, parsed again at fire). Unit + integration tests red before; Stryker 100% (14/14). Confirmed by Catancast: Settlewood vendors 63a45a1 (78c3bee on claude/hillclimb-63b37a), its payload-less bot timer runs on the real alarm under wrangler dev with no `timer.failed` |

Test infrastructure: two existing unit tests (a 280k-key record delta, nine `pnpm pack`
subprocesses) timed out at the 5 s default on a loaded machine and failed the pre-commit hook; they
got explicit timeouts, assertions unchanged.


## Decisions

- ADR-020 E reaping is opt-in (coordinator for Jon, 2026-10-18); default-on is Jon's decision.
- ADR-020 heartbeat on by default (Jon, 2026-10-18). One existing test that leaves its fake server
  silent for 60 s (`client-reconnect-resilience.test.ts` "ignores a late close event from the socket
  a disconnect() replaced") now passes `heartbeat: false`; what it checks is unchanged.

## Flaky existing tests seen under load (not changed)

- `tests/integration/scoped-invocations.test.ts` "leaving the state aborts the call…": slept 30 ms
  and expected a 150 ms service call still in flight; under a full parallel run the call finished
  first (`done` instead of `cancelled`), at baseline and on this branch. Genuine test race: the call
  now takes 1 s (assertions unchanged; the late result still lands inside the test's `until`).
- `tests/integration/studio.test.ts` "lists every journaled event…": 5 s default timeout during the
  full parallel run; passes alone.
- Root fix for the timeouts: `testTimeout: 30_000` in both vitest configs (no test changed). Two
  more unit tests (`journal-archive` property, `studio-ui-json` large array) had timed out at
  load average 45; both pass alone.
- `studio-ui-redrive.test.tsx` "shows seconds under a minute…" read the real clock twice (offset,
  then render) and saw "(in 4s)" under load: a genuine test race. Its describe now freezes `Date`
  only (`vi.useFakeTimers({ toFake: ["Date"] })`); assertions unchanged.
- `studio-ui-timers.test.tsx` "counts seconds up to a minute…": the same two-clock-reads race ("in 59s"
  for 60 s); same fix.
- `pnpm typecheck:budget` check time (wall clock) went over 2 s at load average 90+; instantiations
  unchanged (693 423).

## After (claude/harden-72e4ea, 2026-10-18)

| Gate | Before | After |
|---|---|---|
| CRAP, unit coverage, every package `src` + studio UI | max 7.1, 0 ≥ 8 | max 7.1 (`test`), 0 ≥ 8; client 7.0, core 7.0, React 6.0 (was 2.0: `useSelector`'s cache check) |
| CRAP, worker with integration coverage (`crap:worker`) | 7.6 (docs/quality.md) | 7.6, 0 ≥ 8 (after splitting `liveIdentity` out of `toLiveConnections`, which the reaped check had pushed to 8.0) |
| Mutation, changed files (client, liveness, frame, binary, delta, codec, React context) | full-run scores above | first run 98.06% (1064/1086); after: liveness 100%, client 97.70%, React 96.55%, frame/binary/codec 100%, delta 99.44%; every survivor equivalent (docs/quality.md) |
| Mutation, core whole package (measured both on this machine) | 99.90% (1035/1036) | 99.82% (1082/1084; 48 more mutants from the frame/payload checks); both survivors equivalent |
| CRAP, core / React | 7.0 / 2.0 | 7.0 / 6.0 (`useSelector`'s cache read), 0 ≥ 8 |
| Seam tests, real client ↔ real actor | 0 | 25, all passing: drops, restarts, hibernation, sleep/wake, an iPad suspended during a turn timer (3), two tabs of one player (4), ghost presence (3, opt-in) |
| Unit tests | 3058 | 3152 |
| Integration tests | 383 | 406 |
| CI | failing at setup on main since 2026-10-10 (pnpm version given twice) | setup fixed: `quality` (typecheck, lint, unit, integration) and `docs` pass; `e2e` 77/78 (below) |

Commits: 9677dd0 seam harness; 0a6bfef core frame + React; c0b3ea6 ADR-020 heartbeat/resync/queue;
6884ef4 whole-payload decode + undecodable report + docs; 0db4d4b ghost presence (it.fails);
74d6985 survivors killed, useView simplified; f005de7 CI; 1e7eb03 progress + timers test;
2dca205 useClient follows a new room; 63a45a1 timer payload (Catancast); 599272f stale-socket reaping
(opt-in); 01c4b24 liveIdentity split.

## Next

1. ADR-020 E is opt-in; making it the default is Jon's call (on the coordinator's morning list).
2. Catancast bugs on actor-kit-2 come first when they arrive.
3. Message ids the actor dedupes on, so a send on a dead-but-OPEN socket can be retried
   (delivery is at most once today).
5. A schema hash in the frame (ADR-020 "not decided").
6. CI e2e: `studio-ui.spec.ts` "server restart" fails only on the Linux runner: after SIGTERM to the
   `wrangler dev` process group the server still answers 10 s later (harness `stop()`, line 252).
   Passes locally on this branch (6.3 s). Fix the helper's kill on Linux.
7. `typecheck:budget` fails commits on a busy machine: its check-time limit is wall clock (2 s; seen
   3-15 s at load 45-300 with instantiations unchanged at 693 431). Needs Jon's call: fail only on
   instantiations and warn on time, or keep it.
