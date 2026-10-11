# Upgrading to 0.3

0.3 makes the agent-first changes of [ADR-018](adrs/018-agent-first-api.md). Each breaking change has a
note below with code before and after. Nothing here needs a data migration: 0.x has no production data
contract.

## testActor runs the runtime's step core (ADR-018 D)

`testActor()` now runs every message through the same `step()` core as the Durable Object and
`simulate()`. Three things that used to pass in tests now behave as they do in production.

**Timers must be declared.** Scheduling a timer the actor does not declare (or with a payload its schema
refuses) throws, as it does in the Worker.

```ts
// Before: recorded, though the Worker would refuse it
messages: { PLAN: message(z.object({}), (s, _p, ctx) => { ctx.schedule("tick", { in: "5s" }); return s; }) },

// After: declare it
messages: { PLAN: message(z.object({}), (s, _p, ctx) => { ctx.schedule("tick", { in: "5s" }); return s; }) },
timers: { tick: timer(z.undefined(), (s) => s) },
```

**Actors with states return the persisted state.** `init` and `send` give `{ shared, phase, local,
stateTimers }`, typed per phase (before, `testActor` could not run them).

```ts
// Before: simulate() only
const sim = simulate({ contracts: [QuizContract] });

// After
const t = testActor(QuizContract);
const s0 = t.init({}); // { shared, phase: "lobby", local: null, stateTimers: [] }
const s1 = (await t.send(s0, "ann", { type: "START" })).state;
if (s1.phase === "round") s1.local.n; // typed
```

**Refusals carry a code.** A refused message still rejects with an `Error`; it is now a `RefusalError`
whose `code` says why.

```ts
// Before
await expect(t.send(s, "bob", { type: "END" })).rejects.toThrow("Guard rejected");

// After (the message still works; the code is stable)
const error = await t.send(s, "bob", { type: "END" }).catch((e) => e);
expect(error.code).toBe("guard_failed");
```
