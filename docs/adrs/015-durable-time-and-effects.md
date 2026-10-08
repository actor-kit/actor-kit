# ADR 015: Durable Time and Effects (ideas from XState v6)

**Date**: 2026-10-07
**Status**: Accepted (recommendations approved by Jon, 2026-10-07). Built 2026-10-08: D1–D5 on branch `claude/adr015-build-15d006` (see docs/quality.md for per-step scores). Forwards got the executions' retries, dead letters and redrive afterwards (per-link `retry`).
**Depends on**: ADR-003 (transactional outbox), ADR-010 (services), ADR-013 (actor journal), ADR-014 (Studio production access)
**Visual version**: https://claude.ai/artifact/HWYzXNta6scCAPbfDN5qEq

## Context

We keep our own engine: handlers are synchronous reducers, `(state, payload, ctx) => state`, and every transition commits state, journal event, outbox rows and links in one `transactionSync`. XState v6 (read from `xstate@6.0.0-alpha.64`, README and `.d.ts`; every feature below is marked `@experimental` there) has an experimental durable runtime whose design solves problems v2 still has:

- **No timers.** The v2 design promised `after: { "5 minutes": ... }` on DO alarms. Nothing in `packages/worker` calls `setAlarm`.
- **Outbox ids are not deterministic.** `outbox-${Date.now()}-${counter}` cannot be matched by replay or restore, and sorting by the id string misorders rows when the counter gains a digit.
- **Restore (ADR-013 step 3) has no rule for pending work.**
- **`testActor()` covers one actor.** No services, links or clock.
- **Migration is one untyped function**, `migrate(persisted, fromVersion)`.

We copy the design, not the code, and add no dependency on `xstate`.

## Decision

### D1. Effect ids are `seq:index`

From v6 `DurableEffectMetadata { id, transitionIndex, effectIndex }`.

- Every effect a transition declares (execution, timer, forward) gets id `${seq}:${index}`. `seq` is the journal sequence of the transition; `index` counts that transition's effects in declaration order.
- With `journal: false`, `seq` comes from a counter in `snapshots`, so ids stay deterministic.
- The id is the primary key of `executions`, `timers` and `forwards`. Rows sort by `(seq, index)` as integers.
- Services receive a third argument `{ effectId }` to use as an idempotency key. Additive.
- Retries reuse the same id.

### D2. Timers: a `timers` block, persisted deadlines, one alarm

From v6 `scheduleTimer`: the acceptance time is persisted, and retried or restored timers keep their original deadline.

```ts
messages: {
  START_ROUND: message(z.object({}), {
    handler: (s, _p, ctx) => {
      ctx.schedule("roundEnd", { in: "30s", key: `round-${s.round + 1}`, payload: { round: s.round + 1 } });
      return { ...s, round: s.round + 1, phase: "answering" };
    },
  }),
  SKIP: message(z.object({}), { handler: (s, _p, ctx) => { ctx.cancel(`round-${s.round}`); return s; } }),
},
timers: {
  roundEnd: timer(z.object({ round: z.number() }), (s, { round }) => (s.round === round ? { ...s, phase: "reveal" } : s)),
},
```

- `timers` is typed like `messages`; `ctx.schedule` only accepts declared names, and payloads are validated by the timer's schema.
- `fire_at = ctx.now() + in` (or `at`), so replay computes the same deadline.
- `key` is unique per actor; scheduling an existing key replaces it (debounce).
- After every commit the runtime sets one alarm to the earliest due timer or outbox retry. `alarm()` fires due timers in `(fire_at, id)` order, each in its own transaction and journal event (`cause_type = "timer"`).
- **Late timers fire, all of them, in order** (Q2), with `ctx.lateBy` set.
- A timer has no caller: role `null`, no guard, not callable from outside.
- Timers work with `journal: false`; the table is the truth (Q5). Only restore needs the journal.
- Studio gets a Timers panel (name, key, due in, payload) and an admin-only "fire now".
- `after` sugar may be added later on top of the `timers` block (Q1).

### D3. Restore rebuilds state and pending work, and runs nothing again

From v6 `execution.restore()`: restart pending timers without replaying entry actions. This is ADR-013 step 3.

- `__restore({ toSeq })` appends a `restore` event; history is never deleted.
- State is the fold up to `toSeq` from the newest checkpoint at or before it, checksum-verified.
- The `timers` table is rebuilt: timers scheduled at or before `toSeq` and not fired or cancelled by `toSeq`, each with its original `fire_at`. Overdue ones fire immediately, in order.
- Effects are matched by effect id. Nothing that already ran runs again.
- **A service whose result was recorded after `toSeq` gets that recorded result redelivered** as a new event after the `restore` event, without calling the service (Q3). The outside world already saw the effect, so state must too.
- On wake the runtime replays from the newest checkpoint when `snapshots.last_seq` is behind the journal.
- Restore needs the Studio `mutate` scope (ADR-014). Studio adds "restore to here" on each timeline row.

### D4. `simulate()`: many actors, a virtual clock, effects as data

From v6 `systemTransition` / `advanceSystemTime` / `SimulatedClock`.

- **Extract a pure `step(state, cause, facts) → { state, effects, event }` core from `actor.ts`** (Q4). The Durable Object and `simulate()` both call it, so the simulator cannot drift from the runtime.
- `simulate({ contracts, seed })` in `@actor-kit/test`: `spawn`, `send`, `pendingEffects()`, `resolve(effectId, result)`, `reject(effectId, error)`, `advance(duration)`, `branch()`, `actor(contract, id)`.
- Services never run unless the test resolves them. `ctx.id()` and `ctx.random()` are seeded. `advance()` fires timers in `(fire_at, id)` order, exactly like `alarm()`.
- Simulated actors write journals, so `replayJournal()` can verify them.

### D5. Typed version chain, replay pinned to the version that wrote it

From v6 `machineVersions` and the `machineVersion` pin. This is ADR-013 step 4.

```ts
versions: [
  version(1, V1State),
  version(2, V2State, { state: (s) => ({ players: s.players.map((id) => ({ id })) }), events: { JOIN: (p) => ({ ...p, avatar: null }) } }),
  version(3, V3State, { rebuild: "replay" }),
],
```

- Each step is typed against the previous version's state; events can be upcast per message type; `rebuild: "replay"` rebuilds state from the journal under the new handlers.
- `replayJournal()` refuses an event whose `code_version` has no path to the current version.
- `versions` replaces `migrate` + `version`. No production data exists, so there is no compatibility shim.

## Adopt / adapt / skip

| v6 feature | Verdict |
|---|---|
| Durable effect ids | adopt (D1) |
| Persisted timer deadlines | adopt (D2) |
| `restore()` without re-running effects | adopt (D3) |
| `systemTransition` + `SimulatedClock` | adapt (D4), on our own `step()` core |
| `machineVersions` + version pin | adapt (D5), merged with ADR-013 upcasters |
| `standardSchemaValidator` | later |
| `xstate/fsm` (optional finite states) | later, after timers |
| `hotSwapActorLogic` | skip |
| Statecharts engine, `serializeMachine`, visual editor | skip |

## Order of work

1. Effect ids (D1), folded together with outbox retries, dead letters and redrive (statuses: `pending`, `running`, `retrying`, `done`, `failed`; `onError` fires after the last attempt; failed rows are the dead letters).
2. Pure `step()` core extracted from `actor.ts`, no behaviour change.
3. Timers (D2) with the alarm scheduler shared with outbox retries, and the Studio Timers panel.
4. `simulate()` (D4).
5. Restore (D3).
6. Version chain (D5).

Each step is test-first. After each batch: mutation testing (Stryker) and CRAP on the changed modules, CRAP < 8, surviving mutants killed or justified as equivalent.

## Consequences

**Positive**: timers that survive hibernation and deploys; one effect identity shared by retries, restore and replay; multi-actor logic testable in milliseconds without the Workers runtime; migrations typed one step at a time.

**Negative**: outbox id format changes (no production data, no shim); extracting `step()` is a large refactor of the runtime file; one more table and an alarm computed on every commit; services gain a third argument and `defineActor` gains `timers` and `versions`.
