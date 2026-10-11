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

## Refusals are typed values with a code, a sentence and a docs link (ADR-018 C)

`simulate().send`, the Durable Object's `send()` RPC (and `ActorRef.send`) return
`{ ok: true } | Refusal`, where a `Refusal` is
`{ ok: false, code, message, expected?, details?, docs }`. The codes are `unknown_message`,
`invalid_payload`, `guard_failed`, `wrong_state`, `no_role`, `not_initialized`, `invalid_delivery` and
`actor_not_found`. Two old codes were renamed: `message_not_found` → `unknown_message`,
`validation_failed` → `invalid_payload`. `detail` is gone: Zod issues are in `details`.

```ts
// Before
expect(room.send("bob", { type: "CLOSE" })).toEqual({ ok: false, error: "guard_failed" });
const r = await stub.send("u", "user", { type: "ADD", n: "x" });
if (!r.ok && r.error === "validation_failed") console.log(r.detail);

// After
expect(room.send("bob", { type: "CLOSE" })).toMatchObject({ ok: false, code: "guard_failed" });
const r = await stub.send("u", "user", { type: "ADD", n: "x" });
if (!r.ok && r.code === "invalid_payload") console.log(r.message, r.details, r.docs);
```

A message refused in the wrong state reads, for example, `ANSWER is accepted in round; the actor is in
lobby.` with `expected: ["round"]` and `details: { phase: "lobby" }`.

## The `__error` frame and the client's `onError` (ADR-018 C)

A refused WebSocket message now gets `{ type: "__error", messageType, code, message, expected?,
details?, docs }`, and `onError` receives a `ClientError` with the same fields (`code` is
`"invalid_frame"` for an error frame the client cannot read).

```ts
// Before
createActorClient({ ..., onError: ({ message, error }) => toast(`${message}: ${error}`) });

// After
createActorClient({ ..., onError: (e) => toast(`${e.messageType}: ${e.message}`) });
```

## Thrown errors carry `code` and `docs` (ADR-018 C)

Every error the library throws is an `ActorKitError` (from `@actor-kit/core`) or a subclass
(`NondeterminismError`, `JournalDivergenceError`, `RefusalError`, ...), with a stable `code` and a `docs`
URL (`https://actorkit.dev/errors/<code>/`). Messages are unchanged or extended with how to fix the
problem, so match on `code` rather than on message text.

```ts
// Before
expect(() => run()).toThrow('Timer "tick" is not declared on this actor');

// After
expect(() => run()).toThrow(expect.objectContaining({ code: "undeclared_timer" }));
```

`ActorRef.send` on a binding that is not an actor-kit Durable Object resolves with an `actor_not_found`
refusal (was `{ ok: false, error: "stub.send not available" }`).
