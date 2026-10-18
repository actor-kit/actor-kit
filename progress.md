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
| 6 | React `useView` rendered the old client's view once after a Provider swap | one frame of the previous room | `useView` tracks its client |

Test infrastructure: two existing unit tests (a 280k-key record delta, nine `pnpm pack`
subprocesses) timed out at the 5 s default on a loaded machine and failed the pre-commit hook; they
got explicit timeouts, assertions unchanged.

Open bug, awaiting a decision (ADR-020 E): after a phone's socket goes half-open and the client
reconnects, the actor keeps the dead socket, so the player stays online after leaving for good
(chat example: onlineCount 2, expected 1). Pinned as `it.fails` in `client-seam.test.ts`.

## Decisions

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
- `pnpm typecheck:budget` check time (wall clock) went over 2 s at load average 90+; instantiations
  unchanged (693 423).

## After

(filled in at the end of the run)
