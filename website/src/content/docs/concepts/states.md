---
title: States
description: Phases with typed locals and state-scoped timers.
---

An actor may declare `states` (ADR-017). Data that only matters in one phase lives in that phase's
**local**, and timers scheduled with `scope: "state"` are cancelled when the actor leaves it.

```typescript
import { setup } from "@actor-kit/worker";
import { z } from "zod";

type Shared = { scores: Record<string, number> };

const quiz = setup({
  states: {
    lobby: {},
    round: { local: z.object({ n: z.number(), answers: z.record(z.string(), z.string()) }), input: z.object({ n: z.number() }) },
    reveal: {},
  },
});
const lobby = quiz.in("lobby");
const round = quiz.in("round");

export const Quiz = quiz.actor("quiz", {
  input: z.object({}),
  init: (): Shared => ({ scores: {} }),
  roles: { any: () => true },
  initial: "lobby",
  states: {
    lobby: lobby.state({
      messages: { START: lobby.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto("round", s, { n: 1 })) },
    }),
    round: round.state({
      enter: (_s: Shared, { n }, ctx) => {
        ctx.schedule("roundEnd", { in: "30s", scope: "state" });
        return { n, answers: {} };
      },
      messages: {
        ANSWER: round.message(z.object({ text: z.string() }), (s: Shared, { text }, ctx) =>
          ctx.stay(s, { ...ctx.local, answers: { ...ctx.local.answers, [ctx.caller]: text } })),
      },
      timers: { roundEnd: round.timer(z.object({}).optional(), (s: Shared, _p, ctx) => ctx.goto("reveal", s)) },
    }),
    reveal: quiz.in("reveal").state({}),
  },
  views: {},
});
```

- The states are declared once, in `setup({ states })`: each one's optional `local` and `enter`
  `input` schemas. `quiz.actor()` takes them from the kit, so `initial` must name a declared state
  and `states` must define every one (each with `quiz.in(name).state({ ... })`), or it is a type error.
- The persisted state is `{ shared, phase, local, stateTimers }`. Views and roles get it
  (`PhasedStateOf<typeof quiz, Shared>`, narrowed by `phase`).
- A handler returns `ctx.stay(shared, local?)`, `ctx.goto(phase, shared, input?)`, or `shared`
  (stay, same local). `goto` checks the target and its `enter` input; `ctx.local` is typed per
  state; the local is parsed by its schema.
- Exit drops the local and cancels the phase's `scope: "state"` timers; `enter` builds the next
  local and may schedule, execute and emit.
- **`goto` to the state the actor is already in re-enters it**: exit runs (its `scope: "state"` timers
  are cancelled, its local dropped) and `enter` runs again with the new input. Say it on purpose with
  `ctx.reenter(shared, input?)` (for example to re-arm a window's timer); to keep the local and the
  timers, return `ctx.stay(...)` instead.
- A message is accepted only in the states that declare it, plus the top-level `messages`;
  otherwise it is rejected with `wrong_state`, before its guard. A message is accepted from every role
  unless it names `roles` (then other roles get `wrong_role`).
- Studio's State panel shows the phase and local; the timeline marks phase changes.

See `examples/quiz/quiz.ts` for a full contract and `tests/unit/states.test.ts` for the
behaviour under `simulate()`.
