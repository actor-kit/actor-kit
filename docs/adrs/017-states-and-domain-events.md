# ADR 017: States with Locals, Domain Events, and One History

**Date**: 2026-10-09
**Status**: Accepted (Jon, 2026-10-09: "before the first game goes live on v2")
**Depends on**: ADR-013 (journal), ADR-015 (timers, step core, simulate), ADR-016 (typed services)
**Ideas from**: XState (David Khourshid's proposed state-local context, Oct 2026), event sourcing practice (domain events, causation/correlation ids)

## Context

- **Phases are hand-rolled.** Games keep `phase: "lobby" | "round" | "reveal"` in state and guard every message with `s.phase === ...`. Data that only matters during a round (answers, a draft) lives in shared state forever, and round timers are cancelled by hand.
- **The journal records commands, not facts.** It stores accepted messages and re-runs handlers on replay. There is no `BidPlaced`; an ignored bid leaves nothing. Replaying under new handlers can tell a different story than what happened.
- **Nothing outside an actor can read its history.** Leaderboards, analytics and search across actors have no feed.
- **Multi-actor flows can't be followed.** Each actor journals its side of a forward or link with nothing tying them together.
- **There are two histories.** Studio's `timeline` table duplicates the journal, with its own retention and redaction.

All of this changes what the journal stores, so it lands before any game has v2 data.

## Decision

### 1. Optional `states`, with typed locals

An actor may declare `states`. Without it, nothing changes.

```ts
defineActor("quiz", {
  init: () => ({ scores: {} as Record<string, number> }),
  initial: "lobby",
  states: {
    lobby: state({
      messages: {
        START: message(z.object({}), (s, _p, ctx) => ctx.goto("round", s, { n: 1 })),
      },
    }),
    round: state({
      local: z.object({ n: z.number(), answers: z.record(z.string(), z.string()) }),
      enter: (s, { n }: { n: number }, ctx) => {
        ctx.schedule("roundEnd", { in: "30s", scope: "state" });
        return { n, answers: {} };
      },
      messages: {
        ANSWER: message(z.object({ text: z.string() }), (s, { text }, ctx) =>
          ctx.stay(s, { ...ctx.local, answers: { ...ctx.local.answers, [ctx.caller]: text } })),
      },
      timers: {
        roundEnd: timer(z.object({}), (s, _p, ctx) => ctx.goto("reveal", score(s, ctx.local))),
      },
    }),
    reveal: state({ messages: { NEXT: message(z.object({}), (s, _p, ctx) => ctx.goto("lobby", s)) } }),
  },
});
```

- The persisted state is `{ shared, phase, local }`. Views, roles and guards receive `phase` and the phase's typed `local`.
- A handler in a state returns `ctx.stay(shared, local?)` or `ctx.goto(phase, shared, enterInput?)`. Plain `return shared` from a handler is `stay` with the same local. Both stay synchronous reducers; the journal, restore and `simulate()` are unchanged.
- **Exit** drops the phase's `local` and cancels every timer scheduled with `scope: "state"` in that phase. **Enter** builds the new `local` from `enter(shared, input, ctx)`; it may schedule, execute and emit.
- A message is accepted only in the states that declare it, plus top-level `messages` (accepted in every state). A message sent in the wrong phase is rejected with `wrong_state`, before guards.
- Types: `ctx.local` is narrowed per state; `goto` checks the target name and its `enter` input; `phase` in views is a union of declared names.
- Studio shows the current phase and local in the State panel; the timeline marks phase changes.

### 2. Domain events: `ctx.emit`

```ts
events: {
  BidPlaced: z.object({ bidder: z.string(), amount: z.number() }),
  BidIgnored: z.object({ bidder: z.string(), amount: z.number(), reason: z.literal("too_low") }),
},
messages: {
  BID: message(z.object({ amount: z.number() }), (s, { amount }, ctx) => {
    if (amount <= highest(s)) { ctx.emit("BidIgnored", { bidder: ctx.caller, amount, reason: "too_low" }); return s; }
    ctx.emit("BidPlaced", { bidder: ctx.caller, amount });
    return { ...s, bids: [...s.bids, { bidder: ctx.caller, amount }] };
  }),
},
```

- `events` declares names and payload schemas; `ctx.emit` is typed by them and parsed on emit.
- Emitted events are stored on the journal row of the transition that emitted them (`emitted` JSON array). A transition that changes nothing but emits is still journaled.
- `replayJournal()` checks that replay emits the same events, in order, as recorded. A mismatch fails with the first differing event, so it also catches handler drift.
- `testActor` returns `emitted`; `simulate()` exposes `sim.events()`.

### 3. An outbound event stream

```ts
publish: { queue: "GAME_EVENTS", events: ["BidPlaced", "AuctionClosed"] },
```

- Each emitted event in `publish.events` gets an outbox row, with an effect id, retries, dead letters and redrive (ADR-015), and is sent to the Queue binding (declared in `env`, ADR-016) after commit.
- Message body: `{ actorType, actorId, seq, index, name, payload, at, causationId, correlationId, idempotencyKey }`. Consumers dedupe on `idempotencyKey`. (ADR-019 E adds `position`, a gap-free per-actor number.)
- `simulate()` collects published messages per queue (`sim.published("GAME_EVENTS")`).

### 4. Causation and correlation ids

- Every journal event gets `correlation_id` and `causation_id`.
- A client or service message starts a new flow: `correlationId` = the event's own id (`${actorType}/${actorId}/${seq}`), no causation.
- Service results, timer firings, forwards received, link updates and published events carry the `correlationId` of the event that caused them, and `causationId` = that event's id or effect id. Forwards and link pushes carry both across actors in metadata.
- Studio shows both and links to the causing event, across actors when it can resolve them.

### 5. One history

- Studio's timeline is read from the journal; the `timeline` table and its writes are removed. A migration drops the table.
- The diff for an entry comes from the event's checkpointed or replayed after-state; redaction (ADR-014) is applied to journal payloads, emitted events and states through `runtime/studio-project.ts`.
- Journal retention (`journal.keep`) is now the only retention.

## Out of scope (later)

R2 archive of pruned events; logging and counting rejected messages; sagas; the optional `@actor-kit/effect` adapter; `after` sugar.

## Order of work

1. One history (timeline from the journal): removes a table before more features write to it.
2. Causation/correlation ids.
3. Domain events (`events`, `ctx.emit`, replay check).
4. Outbound stream (`publish`).
5. States with locals.

Each step is test-first, with Stryker ≥ 90% (survivors justified in `docs/quality.md`) and CRAP < 8 on changed code; examples are updated (auction emits events; a quiz-style example or the chat room uses states).

## Consequences

- **Positive:** phases, their data and their timers become structural; the journal records facts as well as commands; read models get a feed; multi-actor flows can be traced; one history to store, redact and restore.
- **Negative:** the journal row grows (emitted events, two ids); `states` adds the largest type surface in the library; removing `timeline` changes Studio's data source.

## Deviations (as built, 2026-10-10)

The decision was built in the order above. Where the exact API could not be typed without casts,
the closest fully type-safe design was chosen:

- **Typed helpers come from `setup()`.** A `message()` written inline inside `defineActor` cannot
  see the actor's `events` or `states`: TypeScript does not infer a nested generic call from its
  sibling properties (verified with the compiler). So, like XState's `setup()`, declarations come
  first and give typed helpers:
  `const quiz = setup({ events, states: { round: { local, input } } })`, then
  `quiz.message(...)` / `quiz.timer(...)` (typed `ctx.emit`) and
  `quiz.in("round").message / .timer / .state({ enter, messages, timers })` (typed `ctx.local`,
  `ctx.stay`, `ctx.goto`, `enter`'s input and return). The definition takes `events: quiz.events`.
  A plain `message()` handler still has `ctx.emit(name, payload)`, checked at runtime only.
- **`setup()` needs `events`** (`{}` when there are none), so `setup({ events })` alone types emit.
- **Persisted state is `{ shared, phase, local, stateTimers }`**: `stateTimers` lists the keys of
  the timers scheduled with `scope: "state"` in the phase, so exit cancels them as ordinary
  journaled timer cancels (replay and restore need nothing new). A phase without a local has
  `local: null`. A `scope: "state"` timer's key defaults to `${phase}:${timer}`.
- **The initial state cannot have a local** (it is entered by `init`, before any input exists);
  `enter` runs on `goto` only.
- **Phase changes come from state messages, state timers and `enter`.** Top-level messages and
  timers (through `quiz.message` / `quiz.timer`), lifecycle, service and link callbacks see the
  shared state and return the next shared state (a stay); they cannot `goto`.
- **Guards** in a state get the shared state, with `phase` and `local` in their context; views
  and roles get the whole persisted state (`PhasedStateOf<typeof quiz, Shared>`, a union narrowed
  by `phase`).
- **Not yet covered:** `versions` migrations of a states actor see the persisted object.
  (`ContractMessages` covering state messages and `testActor` running actors with states landed in
  0.3, ADR-018 B and D.)
- **Emits take an effect index** (shared with executions, forwards and timers), so a published
  event's effect id is `seq:index` and `idempotencyKey` is stable. Emitting is available in
  message and timer handlers and in `enter`, not in lifecycle, service or link callbacks.
- **Publish rows** are outbox executions of the reserved service `__publish`, so they share the
  outbox's retries, dead letters, redrive and Studio Outbox panel.
- **Studio** shows an entry's flow and cause with a link (this actor: expands the entry; another
  actor: opens its timeline at `?entry=N`), its emitted events, and marks phase changes. An entry
  whose after-state cannot be rebuilt from the journal shows "State not available".
- **Causation for an initial link push** (a new subscriber) is the source's newest event.
