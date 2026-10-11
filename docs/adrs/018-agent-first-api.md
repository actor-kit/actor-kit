# ADR 018: Agent-first API — one shape, typed refusals, safer effects, a frozen journal

**Date**: 2026-10-11
**Status**: Accepted (Jon, 2026-10-11: "make it the best API for agents ever… go")
**Depends on**: ADR-013, ADR-015, ADR-016, ADR-017
**Target release**: 0.3.0 (breaking changes allowed: 0.x under `next`; each one gets an upgrade note)

## Context

0.2.0 shipped with two ways to write an actor (inline `message()` and `setup()` helpers) of which only one is fully typed, refusals that are bare strings, a test harness (`testActor`) that does not share the runtime's `step()` core, determinism checked only in tests, and journal-format gaps (emitted events cannot be upcast, rejections leave no trace, `emit` is missing from some callbacks). Service calls have no handle, no result schema and one delivery mode. Agents write most code against this library, so the bar is: wrong code does not compile, wrong behaviour is refused with a message that says how to fix it, and every test path runs the real runtime.

## Decisions

### A. One canonical shape: setup-first
- `setup({ env?, events?, states?, services? })` returns the kit; `defineActor(name, kit, { ... })` (or `kit.actor(name, { ... })`) is the only documented way to define an actor. `message`, `timer`, `service` and `in(phase)` come from the kit, so `ctx.env`, `ctx.emit`, `ctx.local`, `goto`/`stay` are typed everywhere with no annotations.
- The standalone `message()`/`timer()` exports remain for actors with no events, states or env, but are typed identically (no runtime-only `emit`).
- Docs, examples, READMEs and the website show only this shape.

### B. Complete client types
- `ContractMessages<T>` includes top-level messages and every state's messages. Type tests with `expectTypeOf` and `@ts-expect-error`.

### C. Typed refusals and errors that teach
- `send()` results and client errors are a discriminated union: `{ ok: false, code: "wrong_state" | "no_role" | "guard_failed" | "invalid_payload" | "unknown_message" | ..., message, expected?, details?, docs }`. `message` is a full sentence naming the fix, e.g. `ANSWER is accepted in round; the actor is in lobby`.
- Every thrown library error carries a stable `code` and a docs URL.

### D. One test path
- `testActor()` is rebuilt as a single-actor wrapper over the pure `step()` core (as `simulate()` already is). It supports states, locals, emitted events, timers (recorded), env fakes and typed refusals. Its public API stays; existing tests are the safety net.

### E. Determinism everywhere
- The determinism guards (ADR-016 §5) run in production too, configured by `determinism: "throw" | "warn" | "off"` (default `"warn"`: one structured log line, `nondeterministic: true` on the journal entry, a Studio badge). Tests stay `"throw"`.
- A lint rule (Biome GritQL plugin, shipped in the repo and documented) flags `Date.now`, `new Date()`, `Math.random`, `crypto.randomUUID` inside handler bodies.

### F. Journal format, frozen for 0.3
- **Emitted-event upcasters:** a `versions` step may declare `emitted: { Name: (old) => new }` and renames; replay upcasts recorded events before comparing.
- **Rejections:** a `rejections` table outside the journal (code, message name, caller, role, payload hash, at), a structured log line, a Studio counter. Not replayed.
- **`emit` everywhere:** lifecycle, service `onDone`/`onError`/`onStale` and link callbacks get typed `ctx.emit` with the same effect index rules.
- **Restore notifies links:** the restore entry triggers the normal post-commit push to subscribers.

### G. Service calls with handles, schemas and delivery modes
- `ctx.execute()` returns the effect id; `ctx.cancel(effectId)` aborts an in-flight call (AbortSignal) and journals the cancel; a late result is discarded.
- `onDone`/`onError` get `ctx.effectId`.
- `result: schema` on a service: `fn`'s return is parsed; only the parsed value is journaled and passed to `onDone` (live and replay). Results over a size limit fail with a clear error.
- `delivery: "at-least-once" | "at-most-once"` (default at-least-once). At-most-once commits an "attempt started" marker before `fn`; on wake a marker without a result becomes an `outcome_unknown` dead letter (never auto-resent). Studio shows it.
- An attempt lost to eviction is counted as an attempt with error `{ _tag: "Evicted" }` (retry limits apply; visible in Studio).
- `effect.record(name, value)` attaches audit facts to the result entry (redactable, ignored by replay).
- One structured log line per attempt (effect id, idempotency key, attempt, duration, error tag).

### H. Docs that ship with the code
- Each package ships `docs/` (markdown) and the repo publishes `llms.txt` (an index) and `llms-full.txt`; READMEs point agents there. Every error `docs` URL resolves to a page.
- The Studio CLI and MCP gain `journal <type> <id>` queries (range, cause type, event name, correlation id).

## Not doing (decided)
- Decider mode (state rebuilt from events alone): commands plus recorded, replay-checked events are enough.
- A `saga()` helper: sagas are a recipe on hierarchical states first (ADR-019).
- In-actor projections: the projection helper (ADR-019) covers read models.

## Verification
Test-first for every item; Stryker ≥ 90% with survivors justified in `docs/quality.md`; CRAP < 8; typecheck/unit/integration/lint/e2e green; an upgrade note per breaking change in `docs/upgrading-0.3.md`; examples and Codebreakers-style usage compile.
