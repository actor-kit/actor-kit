# Code quality: mutation score and CRAP

Two gates, measured per package:

- **Mutation score** (Stryker, unit tests only): target ≥ 90%. Score = (killed + timeout) / all mutants, so
  NoCoverage mutants count against it. Integration tests (vitest-pool-workers) do not run under Stryker, so code
  reached only from integration tests shows up as NoCoverage.
- **CRAP** (`scripts/crap.mts`): every function < 8. CC is counted on the AST for the function's own body
  (if, ?:, case, loops, catch, &&, ||, ??, logical assignment, default parameters; not `?.`). Coverage is the
  share of the function's own statements and branch arms that the unit tests ran.

## How to measure

```bash
# Mutation, one package (incremental after the first run)
pnpm exec stryker run --mutate 'packages/core/src/**/*.ts,!packages/core/src/index.ts' --incremental

# CRAP, any set of source directories
pnpm crap packages/core/src packages/client/src
```

## Results per package

Before = baseline on `claude/v2-hardening` at `c1e0750` (2026-10-07). Mutation counts are
killed+timeout / total; "max CRAP" is the highest function score, with the number of functions at or over 8.

| Package | Mutation before | Mutation after | Max CRAP before (≥ 8) | Max CRAP after (≥ 8) |
|---|---|---|---|---|
| core | 78.02% (710/910) | 99.77% (427/428) | 27.7 `encodeDelta` (10) | 6.0 `xxh64` (0) |
| client | 50.23% (222/442) | 97.02% (391/403) | 130.0 `handleBinaryMessage` (5) | 7.0 `handleJsonMessage` (0) |
| react | 50.00% (26/52) | 94.23% (49/52) | 2.1 (0) | 2.0 (0) |
| test | 70.55% (115/163) | 98.17% (161/164); with simulate() 97.92% (705/720) | 9.0 `sendWithEffectsImpl` (1) | 7.0 (0) |
| storybook | no tests (0%) | 100% (35/35) | 20.0 `send` (2) | 4.0 (0) |
| studio (server) | 75.58% (622/823) | 99.19% (732/738) | 42.0 middleware handler (6) | 7.0 `accessConfig`, `route` (0) |
| studio UI (`ui/src`) | 65.45% (896/1369) | 93.05% (1298/1395) | 19.2 `alignPrimitiveArrays` (12) | 7.0 `diffAt` (0) |
| studio-cli | 78.87% (362/459) | 99.28% (414/417) | 30.0 mcp tool handler (6) | 7.0 `get` (0) |
| worker (`src`, ADR-015 branch) | not measured | 99.32% (2195/2210) | 702.0 `fetch` (62, unit coverage only) | 7.8 `pushToSubscriber` (0) |

Notes:
- Survivors are equivalent mutants (table below). Remaining `as` casts in these packages: one commented
  `as Infer<SchemaDefinition<TShape>>` at each generic decode boundary in core (`decode`, `applyDelta`), where the
  compiler cannot relate a runtime walk over `fields` to the mapped type; and storybook's `trigger()`
  (`Object.assign({ type }, payload) as TEvent`), which takes an untyped name and payload by design.
- Studio UI: about 70 of its 97 survivors are Tailwind class strings and colour tables (styling only; every state
  they colour is also shown as text or `data-status`). They are grouped in one row below rather than listed.
- Stryker's incremental mode can keep stale "Survived" results for module-level mutants after new tests kill
  them. Delete `reports/stryker-<pkg>.incremental.json` (or pass `--force`) for final numbers.
- Worker: `actor.ts` (the Durable Object class) is excluded from Stryker: it imports `cloudflare:workers` and runs
  only under vitest-pool-workers, which Stryker cannot drive. Its logic that is worth mutating lives in `runtime/`
  (step core, journal, outbox, timers, restore, versions, connect-request, close-code, ...). `index.ts`, `testing.ts`
  and `token.ts` are re-exports. Worker CRAP is measured with `pnpm crap:worker`, which adds the integration
  suite's istanbul coverage (run inside workerd from source) to unit coverage; with unit coverage alone every
  `actor.ts` function scores as uncovered.
- ADR-015 per-step runs on the changed modules, before the final worker-wide run: steps 1-2 (effect ids, retries,
  step core) 98.79%; step 3 (timers) 96.21%; steps 4-5 (simulate, restore) 94.76%. Survivors were then killed.
- Studio's registry Durable Object runs under unit tests through `tests/unit/studio-server-fake-do.ts`, a thin
  `SqlStorage` fake over `node:sqlite`.

## ADR-016 (typed services), per step

Stryker scoped to each step's changed files (new modules whole, changed line ranges of existing ones);
CRAP over `packages/worker/src/runtime`, `packages/test/src`, `packages/core/src` and `pnpm crap:worker`.

| Step | Mutated | Score | Survivors | Max CRAP |
|---|---|---|---|---|
| 1. Idempotency (`effect-info.ts`, delivery in step/journal/simulate/testActor) | 107 | 99.07% (106/107) after killing `step.ts` `delivery === undefined` (first run 98.17%, 2 survivors) | `simulate.ts` `from !== null` before delivering forwards (equivalent, listed below) | 7.0 (runtime, test), 6.0 (core) |
| 2. Typed errors (`service-error.ts`, `retry.ts` rule/settleTry, outbox-store tag, studio-project, simulate reject, outbox panel) | 345 | 91.30% (315/345) first run; survivors then killed (tests for isTaggedError, look-alike Errors, linkRetryRules, undeclared services) or removed by simplifying (`describeServiceError` through a schema, the failure read from its symbol, plain `z.union` built-in schemas that cannot throw on load); re-run below | see "Equivalent mutants" (service-error.ts, retry.ts) | see final row |
| 3. Timeouts (`attempt.ts`, `link.ts` timeoutMs) + re-run of step 2's changed functions | 218 | 95.41% (208/218); then `runAttempt` simplified (no `done` flag: a promise settles once) and the `finish` test fixed to kill `inFlight.finish` mutants | see "Equivalent mutants" (attempt.ts) | see final row |
| 4. Typed env (`env.ts`, testActor/simulate env, onDone/onError ctx.env in step) | 244 | 88.52% (216/244) first run; testActor's hand-written env-schema guard (23 survivors) replaced by the typed contract shape, `once` dropped from the abort listener; re-run below | `simulate.ts` env memo (equivalent, below) | see final row |
| 5. Determinism guards (`determinism.ts`, StepFacts.guard, replay/simulate/testActor wiring) | 130 | 90.00% (117/130) first run; message-text, nested-guard and raw-def env tests added | see "Equivalent mutants" (determinism.ts) | see final row |
| Final re-run of steps 4-5 changed code (`determinism.ts`, simulate `errorOf`/`declaredError`, testActor env) | 127 | **97.64% (124/127)** | 3 equivalent (determinism.ts) | studio UI 7.0; worker (unit + integration, `crap:worker`) **7.8**; runtime 7.0, test 7.0, core 6.0; 0 functions ≥ 8 |

## ADR-017 (states), Stryker on `runtime/phases.ts`, `setup.ts`, `studio/ui/src/phase-change.ts`

| Run | Score | Survivors |
|---|---|---|
| First | 89.72% (96/107) | 11 |
| After | **98.94% (93/94)** | 1, equivalent (setup.ts:226, below) |

- Killed by `states-setup.test.ts`: setup.ts:206-207 (setup's body / returned object; static mutants that broke only
  module-level setup() calls, which Stryker's Vitest runner reports as survived, now also called inside a test),
  setup.ts:219 ×2 (`in()` for a phase typed but not declared at runtime), phases.ts:32 (`goto()` has no local),
  phases.ts:91 `def.messages?.[name]` (wrong_state with states that declare no messages).
- Removed by simplifying (redundant checks, no behaviour change): phase-change.ts:8 (an entry whose state is
  unavailable has a null state, so the `stateUnavailable` check is dropped), phase-change.ts:18 (`phase !== null`:
  a null phase returned null anyway), phases.ts:91 `other !== phase` (the caller asks only after the current
  state did not declare the message; `declaredInAnotherState` is now `declaredInSomeState`).
- CRAP after: studio UI max 7.0 (0 ≥ 8); worker with `pnpm crap:worker` max 7.6 (0 ≥ 8).

## ADR-018 (agent-first API), per step

| Step | Mutated | Score | Survivors | Max CRAP |
|---|---|---|---|---|
| 2. D testActor over `step()` (`test-actor.ts` whole, `refusal.ts`, `outbox.ts` `getSchedules`, `step.ts` `initialState`) | 171 | 95.95% (166/173) first run; then tests for the `wrong_state` message and `unlink(name)` (testActor has no stored links: targets come from the same transition) and the unreachable `detail ?? "unknown"` fallback removed; re-run of `test-actor.ts`: **98.52% (133/135)** | 2 equivalent (test-actor.ts:171, :190, below) | test 7.1, runtime 7.0, core 6.0, worker (`crap:worker`) 7.6; 0 ≥ 8 |
| 3. C typed refusals and coded errors (`core/errors.ts`, `worker/runtime/refusal.ts` whole; every changed line of the ~100 throw sites moved to `ActorKitError`, `client.ts` `clientError`, `step.ts` admission issues, simulate/testActor refusals) | 471 | 74.89% first run (106 survivors: nearly all an error code literal → `""` at a throw site no test asked the code of); then `error-codes.test.ts` (one row per throw site: the call and the code it carries), `refusals.test.ts` details (dotted paths, `toStrictEqual` for optional fields) and `refusal.ts` restructured (wrong_state carries its phase and states from `admitStepMessage`; no lookups that could not fail) → **96.39% (454/471)** | 17: 11 error-code literals → `""` at sites only reachable in workerd or the browser (client `getHeaders`, React provider, Studio RPC stub, restore ×3, journal checkpoint/rebuild/restore-coverage ×3, simulate rejection/effect ambiguity ×3): `""` is not an `ErrorCode`, so each mutant is a compile error that Stryker (no TypeScript checker: its checker cannot load TypeScript 7) runs anyway; plus the equivalents below (errors.ts:277, simulate.ts:306 ×3, simulate.ts:725) | client 7.0 (`buildUrl` was 10.0 after the same-origin merge: split into `pageLocation` / `schemeOf`), core 6.0, react 2.0, test 7.1, runtime 7.0, studio 7.0, worker (`crap:worker`) 7.6; 0 ≥ 8 |
| 4. A setup-first (`setup.ts` whole: `kitOf`, `kit.actor`; `define.ts` whole: the kit overload and `isKit`) | 59 | 69.49% first run (define.ts 19%: `defineActor(name, kit, def)` was only type-tested); then runtime tests of the dispatch (kit, plain def, a def with a non-function `actor`, null, a string) → **98.31% (58/59)** | 1 equivalent (setup.ts:278, below) | runtime 7.0, test 7.1, core 6.0, client 7.0, worker (`crap:worker`) 7.6; 0 ≥ 8 |
| 5. G service handles (`service-options.ts` whole; changed lines of `outbox.ts`, `outbox-store.ts`, `effect-info.ts`, `service-error.ts`, `step.ts`, `setup.ts`, `simulate.ts`, `sim-def.ts`) | 219 | 73.52% first run (the actor-side helpers were reached only from workerd); then unit tests for `parsedOutcome`, the store's interrupted/cancelled rows (`outbox-store-cancel.test.ts`), result parsing edges (non-JSON, nested issue paths, undefined), option resolution moved out of `describe` bodies (a resolver mutant failed the file's collection, which Stryker reports as survived) → **95.89%**; final run of `service-options.ts` and the step's callback ctx: **99.35% (152/153)** | 1 equivalent (service-options.ts:139, below); simulate.ts:485 `["Stryker was here"]` for a non-cancel op is never an effect id (equivalent) | runtime 7.0 (`resolveServiceOptions` 8.0 → `deliveryPolicy` split; `runCallback` 8.0 → `callbackCtx`), test 7.1, worker (`crap:worker`) 7.6 (`endExecution`'s catch is covered by an onDone that throws, `service-handles.test.ts`); 0 ≥ 8 |
| 6. F journal format (`rejections.ts` whole; changed lines of `versions.ts`, `journal.ts`, `step.ts`, `define.ts`, `link.ts`, `setup.ts`, `simulate.ts`, Studio `protocol.ts` / `studio-state.ts` / `actor-detail.tsx`) | 91 | 93.41% (85/91) first run; then a version-2 event kept out of step 2's rename, an onUnlink that emits, and the chain compiled inside each test (a schema mutant failed the file's collection) → re-run of those lines **100% (37/37)** | 1 equivalent (studio-state.ts:111, below) | runtime 7.0, test 7.1, studio UI 7.0, worker (`crap:worker`) 7.6; 0 ≥ 8 |
| 7. E determinism in production (`determinism.ts` changed lines: warn mode, nesting, watch, flag, log line, option; `journal.ts` flag column; `journal-timeline.ts`; Studio `protocol.ts` / `timeline-panel.tsx` badge) | 138 | **99.28% (137/138)**; the one survivor (throw-mode watch's empty `violations`) killed by asserting the whole watch | none | runtime 7.0, studio UI 7.0, worker (`crap:worker`) 7.6; 0 ≥ 8 |
| 8. H docs that ship with the code (`scripts/docs.mts`, `scripts/gen-docs.mts`; generated error pages, package `docs/`, `llms.txt`, `llms-full.txt`) | n/a | no library source changed (Stryker mutates `packages/*/src`); the generator is pinned by `docs-generated.test.ts` (generated files up to date, every code's page exists, every errors URL in the sources resolves, every package publishes `docs/`, llms files complete) | — | unchanged |
| RSJ 3. Roles on messages (`message-roles.ts` whole; `refusal.ts` wrong_role; `message.ts`; `step.ts` admission) | 120 | 94.32% first run, then edge tests (role-nested and junk entries, a caller-less refusal, `toStrictEqual` on message options, a states-only actor) → **96.67% (112/116)** | 4 equivalent (message-roles.ts:23, :26, :28; step.ts:312, below) | runtime 7.0; 0 ≥ 8 |
| RSJ 4. `ctx.reenter` (`step.ts` phase context) | 1 | **100% (1/1)** | none | runtime 7.0; 0 ≥ 8 |
| RSJ 2. `simulate().spawnSync` (`simulate.ts` spawn refactor, `step.ts` `stepInitSync`) | 52 | 86.79% first run; then tests for the handle's links, an async init that rejects (no unhandled rejection) and a missing init → **96.15%** | 2 equivalent (simulate.ts:783, init's unlink targets, listed below) | test 7.1, runtime 7.0; 0 ≥ 8 |
| RSJ 6. `actorClient<typeof Contract>({ roles, views })` (`builder.ts` whole) | 51 | **88.24% (45/51)** on the whole file; all 6 survivors are the existing equivalents (renumbered, plus the roles-and-views twin of the name-and-def check, below) | 6 equivalent (5 existing, renumbered; 1 new: builder.ts:108) | client 7.0; 0 ≥ 8 |

## ADR-019 (hierarchical states, scoped invocations, journal archive), per step

| Step | Mutated | Score | Survivors | Max CRAP |
|---|---|---|---|---|
| A. Nested states (`phases.ts`, `phase-run.ts`, `state-paths.ts` whole; `step.ts` admission, timer/message lookup, phaseRun, runHandler, stepMessage, stepTimer; `refusal.ts` placeOf; `setup.ts` `in()`/declAt; Studio `phase-change.ts`, State panel PhaseLine) | 565 | 89.60% first run (50 survivors, 15 no coverage); then tests for every error message, stay without a local, unscoped timers at a level, a parent-level handler's schedule and local, bubbling past message-less levels, the innermost-first `expected` list, `upgradePhased`, a role without top-level messages; and simplifications (no pre-validation before exits: entering validates; goto told apart from stay by its target; `innermost` iterates entries reversed; `isPlainObject` dropped; `matches` without the length check; handler-promise check left to the caller, which names the message) → **99.13% (560/565)**; the last 5 then killed (or the code simplified: the undeclared-state message names the path asked for, each walk goes one level deeper) → phases.ts + phase-run.ts re-run **100% (303/303)** | none | runtime 7.0, test 7.1, core 6.0, studio UI 7.0, worker (`crap:worker`) 7.6; 0 ≥ 8 |
| B. Scoped invocations (`phase-run.ts` whole; `step.ts` plainExecute, service callbacks (atCallLevel, onDone/onError/onStale, runCallback, stepCallback); `attempt.ts` runAttempt; `outbox-store.ts` startAttempt, cancelExecutionRows; `outbox.ts` cancel; `journal.ts` / `journal-timeline.ts` service.stale; `simulate.ts` stale calls; Studio cause summary) | 530 | 94.02% first run (29 survivors, 5 no coverage); then tests for the owning level of a callback (a parent's call sees the parent's local, a child's the child's, an unowned one the leaf's), the not-journaled unchanged callback, a stale call settling once, a late result for an undeclared service, Studio's service.stale summary, label and timeline cause; and simplifications (runAttempt's two flags, no redundant finish guard; the callback-identity check through a recorded list) → re-run of the changed ranges **97.74% (253/259)**, then the owner-level survivors killed | 2 equivalent (simulate.ts:491, :495, below) | runtime 7.0, test 7.1, core 6.0, studio UI 7.0, worker (`crap:worker`) 7.6 after splitting `runExecution` (8.0: CC 8 with `startExecution` folded in); 0 ≥ 8 |
| D. Journal archive to R2 (`journal-archive.ts` whole; `journal.ts` config and append; Studio `journal-storage.ts`, the header's journal line, the snapshot reducer) | 273 | 88.75% first run (35 survivors: the property tests cannot see an archive that writes less, so `oldest > base` → `>=` and the default transaction survived; error-message and bucket-shape details; a module-level zod schema whose static mutants only broke module load); then unit tests that appending with an archive never prunes inline, one-event segments, `archiveDue`'s default transaction, a range ending where a segment ends, a broken line's number, every non-bucket binding, bytes up to TB, a header without an archive or a warning; and simplifications (the oldest event searched below the base, no redundant `null` checks through a union row schema, the segment schema built per parse, no sort of already ordered checkpoints, a segment ending at `from` is not fetched) → **98.65% (285/289)**, then the 3-segment summary case added | 3 equivalent (journal-archive.ts:62, studio-state.ts:111, :112, below) | runtime 7.0, test 7.1, core 6.0, studio UI 7.0, worker (`crap:worker`) 7.6; 0 ≥ 8 |
| Merge of the ADR-019 parallel branch (C, E, F): `__journal` over the archive (`readArchivedJournalPage`, `segmentsFor`; `journal-query.ts` `journalEntry`, `matchesJournalQuery`), the client builder's name for `{ roles, views }` clients | 106 | 92.17% first run (property test only; 9 survivors); then example tests per filter, the window edges (a segment ending at `from`, `before - 1`), oldest-first pages that a full local page must not stop, an exact `hasMore`, and the `{ roles, views }` client's error name; `matchesJournalQuery` restructured (CRAP 8.8 → 2) and the segment window split out (8.0 → 4) | 3 equivalent (builder.ts:108, :110, journal-query.ts:154, below) | runtime 7.0, test 7.1, core 7.0, client 7.0, studio 7.0, studio-cli 7.0, studio UI 7.0, worker (`crap:worker`) 7.6; 0 ≥ 8 |

## ADR-019 C (richer view schemas), Stryker on `core/src/schema.ts`, `codec.ts`, `delta.ts` (whole files)

| Run | Score | Survivors |
|---|---|---|
| First | 98.64% (574/582) | 8: `isFloat` float32 arm (×2), nullable float vs `null` (×2), `nextEntries[i]?.[0]`, `valueMetaOf` guard (×2, one NoCoverage), `a === b` fast path |
| After | **99.83% (586/587)** | 1, equivalent (delta.ts:58 fast path, below) |

- Killed by `core-rich-schemas.test.ts` "float tolerance in deltas" (float32 tolerance; a `null` previous or next
  value is never "within 1e-6" of a number) and "are read through the schema that built them".
- Removed by simplifying: the record order check walks `nextEntries` (always defined) instead of indexing it.
- Found by the property tests (`core-rich-schemas.property.test.ts`, fast-check over random nested schemas):
  the 1e-6 float tolerance also hid small changes in `json`, enum and integer values (it now applies to float
  fields only). Found by `pnpm crap`'s coverage run: the enum distinct-values check was O(n²) (65536 values took
  over 5s); it is a Set now.
- CRAP: core max 7.0 (0 ≥ 8). client max 10.0: `url.ts buildUrl` (CC 10, 100% covered), unchanged by this work
  (came in with `a2594c6`, same-origin socket scheme); listed as a follow-up.

## ADR-019 F (journal query)

Stryker on `worker/runtime/journal-query.ts` (whole), `studio-cli/src/shape.ts` (whole) and the changed
ranges of `studio-project.ts` (`projectJournalEntry`), `studio/src/middleware.ts` (journal query schema,
`handleJournal`), `studio-cli/src/cli.ts` (`journal`, `order`), `client.ts` (journal schema and call) and
`mcp.ts` (`studio_journal`).

| Run | Score | Survivors |
|---|---|---|
| First | 91.73% (233/254) | 23: CLI and MCP messages and descriptions, `order=desc` accepted, malformed id / unbound type on the journal route, `hasMore` with a page that holds exactly the rest, ORDER BY `""` |
| After | **99.28% (273/275)** | 2, equivalent: journal-query.ts:111 (below) and the existing shape.ts:43 row |

- CRAP: studio max 7.0, studio-cli max 7.0, worker (`pnpm crap:worker`, unit + integration) max 7.6; 0 functions ≥ 8.
- `studio-mcp.test.ts` "exposes exactly the read-only tools" now lists `studio_journal`: ADR-019 F adds that
  read-only tool, and the test's point (every tool is read-only) is unchanged.

## ADR-019 E (published-event positions, `@actor-kit/projection`)

Stryker on `packages/projection/src/**` (all but `index.ts`) and `worker/runtime/publish.ts`.

| Run | Score | Survivors |
|---|---|---|
| First | 94.30% (234/244 + 4 timeouts) | 15: projections built at module load in the test (a mutant that makes the constructor throw breaks the file's import, which Stryker's runner reports as survived), `via` unchecked, rebuild without `reset`, the default `fetch`, `actorId` length 1 in every test, and the race handling below |
| After | **100% (250/254 killed + 4 timeouts)** | none |

- Found while killing them: after losing a race to another consumer (its cursor row already there), the
  drain stopped, so a later buffered event of that actor could wait for the next message. A conflict now
  means "applied": the drain continues. `buffered()` lists only events after the cursor (a lost race can
  leave a stale row, removed by the next drain).
- `simulate()`'s position (`packages/test`): covered by `publish.test.ts`; CRAP for `packages/test/src` max 7.1.
- CRAP: projection max 7.0, test max 7.1, worker (`pnpm crap:worker`) max 7.6; 0 functions ≥ 8.

## View schema validation (StandardSchemaV1), Stryker on `core/src/validate.ts`, `meta.ts`, `schema.ts`

| Run | Score | Survivors |
|---|---|---|
| First | 94.95% (339/357) | 18: messages (array, object, number, boolean), the 65535 boundaries (`>` vs `>=`), the `or null` path of a top-level nullable, `SchemaValidationError` name and path separator, nullable array elements, and checks that did not read their argument |
| After | **99.73% (365/366)** | 1: validate.ts `validates` body emptied, which leaves every descriptor without a validator at module load; Stryker's Vitest runner reports a module-load failure as survived (same family as retry.ts:64) |

- `client/src/initial-view.ts` (create() validating `initialView`): 92.31% first run (issue formatting duplicated from
  core, `null` and non-string roles, a contract with neither roles nor schemas); after reusing core's
  `describeIssues` and adding those tests, 100% (69/69). Run together with `validate.ts`: 99.65% (282/283).
- Removed by simplifying: the string byte-length check moved into its own `checkString`; `checkFields` takes the schema, not a meta it did not read; `issuesOf`'s `nullable` has no default.
- CRAP: core max 7.0 (0 ≥ 8).

## Varint lengths and counts (strings over 65535 bytes corrupted the frame)

Every length and count on the wire is now an unsigned LEB128 varint (`codec.ts` `writeVarint` /
`readVarint` / `varintSize`; record-delta counts in `delta.ts`). The validator's 65535 limits went with it.

| Run (`codec.ts`, `delta.ts`, `validate.ts`, whole files) | Score | Survivors |
|---|---|---|
| First | 99.56% (660/668 + 5 timeouts) | 3: varint bound `<` → `<=` (killed by a 9-byte length ending in `0x01`), and the existing delta.ts fast path and validate.ts module-load rows |
| After | **99.70% (666/668)** | 2, equivalent: delta.ts:61 fast path and the validate.ts module-load row (`validates` body) |

## Merge of ADR-019 C/E/F into ADR-018 (claude/v0.3)

- ADR-018 C applied to the ADR-019 code: schema building throws `invalid_schema`, encoding a value outside its
  schema and `parse()` throw `invalid_view_value`, decoding bytes a schema cannot have written throws
  `invalid_frame`, the journal query throws `invalid_journal_query`, `@actor-kit/projection` throws
  `invalid_projection` / `incomplete_journal` (and `studio_request_failed`, `actor_not_found` from its journal
  sources), and `InitialViewError` is an `ActorKitError` (`invalid_initial_view`). `errors-have-codes.test.ts`
  now also scans `packages/projection/src` (stricter). Pinned by `adr019-error-codes.test.ts`.
- `actorClient<typeof C>({ roles, views })` validates `initialView` through the same schemas
  (`client-initial-view.test.ts`).
- Stryker on `errors.ts`, `meta.ts`, `validate.ts`, `initial-view.ts`, `builder.ts`, `journal-query.ts` and
  `projection/src/**`: **99.02% (594/600)**; the 6 survivors are the existing rows below (builder.ts ×4,
  errors.ts:309, journal-query.ts:113), renumbered.
- CRAP after the merge: every package max ≤ 7.6 (worker with `pnpm crap:worker`), 0 functions ≥ 8;
  `buildUrl` came down with ADR-018's split.
- `core-varint-lengths.test.ts`'s property test generated tens of thousands of random graphemes per long
  string (1.1s alone; it timed out under `pnpm crap:worker`'s coverage on a loaded machine). Long strings are
  now a short random sample repeated past 65536 bytes: same property, 0.1s.

## Merge of ADR-019 A/B/D (claude/adr019-states) into claude/v0.3

Both lines had merged the ADR-019 C/E/F branch and resolved it alike (the same three error codes, the same
builder fix). Stryker on the files whose merged content differs from both parents (`core/errors.ts`,
`worker/runtime/migrations.ts`): **98.73% (77/78)**; the survivor is the existing errors.ts row (now line 333).
Migrations renumbered: `0020_publish_position`, `0021_journal_archive`.

## Run Set Jimmy feedback, round 2 (v0.3 items 14-19)

| Item | Mutated | Score | Survivors | Max CRAP |
|---|---|---|---|---|
| 14. Goto with kept locals, enter updating the levels above (`phases.ts` goto and its options; `phase-run.ts` enterLevel, updateAbove, withKeptLocals, descend, gotoPath, settle) | 143 | 93.67% first run (10 survivors: two `i + 1` path slices only a three-level tree tells apart, the option issues' join, and conditions the runtime already implies); then a three-level test (grandchild enter updating both levels above, a goto keeping two levels), the exact options message with two issues, and simplifications (one `goto` constructor call; `updateAbove` parses every level, a level without a local parses to null; kept levels looked up in one map) → **100% (143/143)** | none | runtime 7.0, core 7.0, test 7.1, worker (`crap:worker`) 7.6; 0 ≥ 8 |
| 15. State-path helpers in core (`core/src/state-paths.ts` whole: `matches`, `localOf`, `mergeLocals`, moved from the worker, which re-exports them) | 38 | **100% (38/38)** | none | core 7.0, runtime 7.0, worker (`crap:worker`) 7.6; 0 ≥ 8 |
| 16. Docs: client code's own zod import, `zod/mini` | n/a | docs only (bundle sizes measured with esbuild: 453 KB classic, 13 KB mini) | — | unchanged |
| 17. `0.3.0-next.0` versions, `scripts/vendor.sh` / `scripts/vendor.mts` | n/a | no package source changed (Stryker mutates `packages/*/src`); the script is pinned by `tests/unit/vendor.test.ts` (versions, names, manifest rewrite, a real pack of all nine packages; file lists identical to `pnpm pack`) | — | unchanged |
| 18. Typed Durable Object stub (`worker/src/rpc-types.ts`, `TypedActorClass` in `actor.ts`, `core/src/contract-types.ts`) | 0 | types only, no runtime code (nothing for Stryker to mutate); pinned by `typed-stub.types.test.ts` against Cloudflare's `DurableObjectNamespace` / RPC types (every result not `never`, role-narrowed views, the persisted state) | — | unchanged (no functions changed) |

## Equivalent mutants

Surviving mutants that no test can kill, because the mutated program behaves identically. One line each.

| Package | Location | Mutant | Why it is equivalent |
|---|---|---|---|
| core | delta.ts:61 | `if (a === b) return true` → `if (false)` | Fast path only; the number and JSON comparisons below return the same result. |
| client | builder.ts:108, :109 | `"name" in arg && "def" in arg` / `"roles" in arg && "views" in arg` → `\|\|` | A SchemaDefinition has none of these keys; a contract has both name and def, the roles-and-views form both roles and views. |
| client | builder.ts:116, 120 (×3) | `isRecord` / `isViewSchema` → `true` | A non-schema registered for a role makes decode throw, which the client catches and ignores, the same as having no schema. |
| client | builder.ts:131 | `if (isViewSchema(...))` → `true` | Registers `undefined` for the role; `viewSchemas[role] ?? viewSchema` falls back exactly as when it is absent. |
| client | client.ts:155, 156, 164 | `roleIndex === undefined ? …` / `roleName === undefined ? …` → `false` | parseFrame always sets roleIndex on snapshots, and indexing with `undefined` yields `undefined` anyway. |
| client | client.ts:179 | `onRedirect?.(…)` → `onRedirect(…)` | Binary path only: the TypeError is caught by handleBinaryMessage's try/catch, same as doing nothing. |
| client | client.ts:267 | `typeof data === "string"` → `true` | Non-string data fails JSON.parse (or parses to a non-object) and is ignored either way. |
| client | client.ts:377 | parseJson `catch { return undefined }` → `{}` | Returns `undefined` either way. |
| client | url.ts:25 | `lastColon >= 0` → `> 0` | Differs only for a host starting with `:`, which is `wss` either way. |
| react | context.ts:67 | `client.view !== undefined` → `true` | Only adds `setView(undefined)` when the state is already `undefined`. |
| react | context.ts:91 | `client.role !== role` → `true` | Setting the same state value is a React no-op. |
| react | context.ts:135 | effect deps `[client]` → `[]` | The client comes from a `useState` initializer and never changes. |
| test | test-actor.ts:171 | `typeof record !== "object" \|\| record === null` → `false` | A primitive role entry still yields no messages. |
| test | test-actor.ts:190 | `slots !== undefined` → `true` | The router treats an `undefined` role entry as "message not found" anyway. |
| studio | access.ts:161 | `catch` block → `{}` | Falls through to the same 401 "Invalid Cloudflare Access token". |
| studio | middleware.ts:147 | `join(".")` → `join("")` | Every request schema's error paths have a single segment, so there is nothing to join. |
| studio | middleware.ts:237 (×3) | `rawType !== undefined && rawId !== undefined` → `\|\|` / `true` | Both regex groups are required, so a match always fills both; the check exists for the type checker. |
| studio | registry.ts:81 | `previousActorId !== actorId` → `true` | Deleting and re-inserting the same row in one transaction leaves an identical row. |
| studio-cli | cli.ts:50 | `actorType === undefined` → `false` | `actorId` is `undefined` whenever `actorType` is, so the same error is thrown. |
| studio-cli | client.ts:78 | `{ state: z.unknown() }` → `{}` | `z.unknown()` accepts a missing key; only the static type differs. |
| studio-cli | shape.ts:43 | `catch { return undefined }` → `{}` | Returns `undefined` either way. |
| studio UI | all components | ~70 className literals, colour tables (OUTBOX_STATUS_CLASS, SCALAR_CLASS, CAUSE_LABELS colours), status-badge pulse dot, active-tab class, table header alignments, `TABLE_CLASS` / `ROW_CLASS` / `CELL`, JSON tree `TOGGLE_CLASS` | Styling only; each state is also rendered as text or `data-status`. The phone rules (`components/phone.ts`: `TAP`, `SCROLL_X`) are not in this group: `studio-ui-phone.test.tsx` pins them and `tests/e2e-studio/studio-mobile.spec.ts` measures them. |
| studio UI | timeline-panel.tsx:14-16, 24-25 | cause label entries (init, migrate, message, timer, restore) → `[]` or key `""` | The fallback label equals the cause type; only the colour differs. |
| studio UI | inspect-panels.tsx:91,117; actor-table.tsx:19; json-diff.tsx:41 | React key template → `""` | Keys only; no visible difference for distinct rows. |
| studio UI | actor-detail.tsx:13 | useParams `{ from }` → `{}` | Same params from the single matching route. |
| studio UI | actor-detail.tsx:15 | remount key → `""` | ActorTabs already unmounts on an actor switch because the hook resets `inspect` to null. |
| studio UI | compute-diff.ts:107,109 (×2) | prefix bound `Math.max` / `<=` / `true` | Reading past the end gives `undefined`, which never equals a JSON primitive, so the loop stops anyway. |
| studio UI | compute-diff.ts:126 | loop start `a.length - 1` → `+ 1` | Extra rows write out of bounds (ignored) or zeros; same result. |
| studio UI | api.ts:65 | `catch { return undefined }` → `{}` | Returns `undefined` either way. |
| studio UI | protocol.ts:17 | addIssue code `"custom"` → `""` | Same message. |
| studio UI | use-actor-list.ts:37,38,44 | empty catch, `[]` deps, initial `{ kind: "loading" }` | The effect sets loading before first paint; same behaviour. |
| studio UI | timers-panel.tsx:21 | `useNow` effect deps `[]` → `["Stryker was here"]` | A constant dependency never changes, so the interval starts once either way. |
| worker | identity.ts:32, 33 | `headers.delete(CALLER_ID_HEADER / CALLER_TYPE_HEADER)` → removed | `headers.set()` just after replaces every inbound value of the name; the explicit scrub is kept on purpose (security code reads as intended). |
| worker | close-code.ts:7 | `code !== undefined && …` → `true && …` | `isSendable(undefined)` is false (every comparison with `undefined` is false); the check is for the type checker. |
| worker | route-to-actor.ts:23 | `actorType === undefined \|\| …` → `false \|\| …` | Parts come from `filter(Boolean)`, so `actorId` (`parts[2]`) is undefined whenever `actorType` (`parts[1]`) is. |
| worker | journal.ts:112, 113 | `facts.unlinked ?? []` / `facts.linkViews ?? []` → `["Stryker was here"]` | Only `findIndex` on `.name` / `.id`: a string has neither, so the same "missing fact" error. |
| worker | journal.ts:310 | `if (base !== null)` → `true` | With `base` NULL, `WHERE seq <= NULL` matches no rows in SQLite. |
| worker | journal.ts:469 | `callerConnections === undefined ? cause : {…}` → always spread | The step core reads `cause.callerConnections === undefined`: a missing key and an `undefined` one behave the same. |
| worker | journal.ts:535, 750 | init / pre-init `timers: []` → `["Stryker was here"]` | Schedule ops filter by `op.key` and only add on `op === "schedule"`; fold results return state only and timer handlers read their payload from the event. |
| worker | studio-project.ts:30 | HMAC key `extractable: false` → `true` | The key never leaves the closure, so the hashes are identical. |
| worker | studio-redact.ts:57 | `if (segment === undefined) continue` → `false` | `walk` returns REDACTED before `step` whenever a cursor is complete, so `step` never sees a past-the-end segment; the check is for the type checker. |
| worker | studio-redact.ts:59 | `segment.kind === "literal" && …` → `true && …` | Kinds are any / one / literal; with any and one excluded only literal is left. |
| worker | versions.ts:118 (×2) | `first?.state` / `first?.rebuild` → `first.…` | The chain schema has `.min(1)`, so `first` is always defined; `?.` is for unchecked index access. |
| test | simulate.ts:179 | `value !== null` → `true` (pushed view spread) | Spreading `null` adds no keys, so `{ role, ...null }` equals `{ role }`. |
| test | simulate.ts:725 | `issues[0]?.message` → `issues[0].message` | A failed parse always has at least one issue. |
| test | simulate.ts:306 (×3) | unknown-contract guard in `defOf` → removed / message `""` / code `""` | Unreachable: an actor exists only after `spawn` registered its contract, and every lookup is for an existing actor's type. The guard is for the type checker. |
| worker | journal-query.ts:154 | `event.emitted ?? []` → `["Stryker was here"]` | A string has no `name`, so the event filter matches nothing either way. |
| worker | journal-archive.ts:62 | `if (base === null) return null` → `if (false)` | With no checkpoint the next query asks `MIN(seq) ... WHERE seq <= NULL`, which SQLite answers with NULL, so the same null comes back. |
| studio UI | studio-state.ts:111, :112 | `frame.rejections === undefined ? {} : {...}` / the same for `journal` → always the object | Sets the key to `undefined` instead of leaving it out; every reader treats both the same. |
| test | simulate.ts:491, :495 | `flatMap(... ? [op] : [])` / `? [op.key] : []` → `["Stryker was here"]` | The strings have no `key`, and a set of keys with `undefined` in it never matches an effect id (`seq:index`), so the same calls are cancelled or kept aside. |
| test | simulate.ts:257 | undeclared or present link `return false` → `true` | Subscribing such a link pushes nothing: an undeclared link has no source, and a present one's view is already pushed (dedupe). |
| test | simulate.ts:265 | unlink(name) unsubscribes `[]` → `["Stryker was here"]` | A string has no `name`, so it points at no source and nothing is forgotten. |
| test | simulate.ts:276 (×2) | `def.links?.[name]?.contract` → without `?.` | Only declared links are ever recorded on an actor, so the link definition always exists. |
| test | simulate.ts:305 | `if (role === null) return` → `if (false)` | `def.views[null]` is `views["null"]`, undefined, so the next check returns. |
| test | simulate.ts:391 | `if (from !== null)` before delivering forwards → `true` | `from` is null only for callbacks (onDone, onError, onUpdate), whose step has an empty outbox: there are no forwards to deliver. |
| worker | determinism.ts:44 (×2) | the temporary replacement's `writable` / `enumerable` flags flipped | Handlers only call the replaced functions; whether they are writable or enumerable for the length of a handler is not observable, and the original descriptor is put back exactly. |
| worker | determinism.ts:75 | `saved.reverse()` → `saved` | Every saved entry is a different (target, key) pair, so the restore order does not matter. |
| test | simulate.ts:248 | `if (!envs.has(type))` → `true` | Only a memo: parsing the same fakes again gives the same env. |
| test | simulate.ts:620, :783 | init's unlink targets `() => []` → `() => undefined` / `["…"]` | Same as the existing simulate.ts:562 row (moved): `init` has no unlink. |
| worker | service-error.ts:39 | `Symbol.for("actor-kit.service-failure")` → `Symbol.for("")` | The same registered symbol is used to mark and to read a failure, so any key works. |
| worker | service-error.ts:68 | whole `if (!(thrown instanceof Error) \|\| !(FAILURE in thrown))` → `false` | A thrown value that is not a failure has no `[FAILURE]`, so it reads `undefined`, which isTaggedError rejects: still null. |
| worker | retry.ts:64 | `parseOption(...)?.while` → `.while` | Kills by throwing a TypeError while test modules load (resolveRetryRule(undefined) via defineActor/link at module level), which Stryker's Vitest runner reports as survived (testing-strategy gotcha); run by hand it fails `service-errors.test.ts`. |
| worker | attempt.ts:20 | `typeof option !== "number"` → `false` | `Number.isFinite` is false for every non-number, so the same error is thrown; the typeof is for the type checker. |
| test | simulate.ts:562 (×2, one NoCoverage) | init's unlink targets `() => []` → `undefined` / `["…"]` | `init` gets no `unlink`, so the fact is never read. |
| worker, studio UI | trace.ts:48, cause-ref.ts:18 (×3 each) | destructuring defaults `= ""` → `"Stryker was here!"` | Groups 1-3 of the id pattern always match when the pattern does; the defaults exist for the type checker. |
| worker | journal.ts:583, 813 | init `timerOps: []` / rebuild-skipped migrate `emitted: []` → `["Stryker was here"]` | Same family as journal.ts:535/750: init schedules nothing, and a rebuild compares neither checksums nor emitted events. |
| worker | journal.ts:647 | `i < length` → `i <= length` | Past the end both lists give `undefined`, which describe the same ("nothing"): no difference is found there. |
| test | simulate.ts:222 | initial `published: []` → `["Stryker was here"]` | `published(queue)` filters by `p.queue`; a string has none, so it is never listed. |
| test | simulate.ts:256 | memo `if (config === undefined)` → `true` | Recomputes the same publish config each time; only slower. |
| test | simulate.ts:301 | `parseEffectId(effectId)?.seq` → `.seq` | Simulated effect ids are always `seq:index`, so the parse never fails. |
| worker | journal-timeline.ts:202 | init start `timers: []` → `["Stryker was here"]` | Same as journal.ts:535/750: an init event schedules nothing from its start point, and timeline states never read the pending timers. |
| worker | journal-timeline.ts:203 | `from === undefined \|\| …` → `false \|\| …` | Folding a non-init event onto no point throws inside the try, which returns null: the same "state not available". |
| worker | service-options.ts:139 | `"aborted" in tried \|\| !tried.ok` → `"" in tried \|\| …` | An aborted try has no `ok`, so `!tried.ok` is already true for it. |
| test | simulate.ts:485 | non-cancel op → `["Stryker was here"]` | That string is never an effect id, so no pending effect is removed. |
| studio UI | studio-state.ts:111 | `frame.rejections === undefined ? {} : { rejections }` → always the spread | A `rejections: undefined` key renders the same nothing as an absent one. |
| worker | message-roles.ts:23, :26, :28 | an empty list → `["Stryker was here"]` | Destructuring a string gives a one-letter "slot" with no `roles`, which names no role, so nothing is refused. |
| worker | step.ts:312 | `roleMessages[role]?.[type]` → without `?.` | Every contract's messages are nested under every role (createActorClass, toSimDef, testActor), so the role's entry always exists. |
| core | errors.ts:333 | `Object.keys(ERROR_CODES).filter(isErrorCode)` → without the filter | Every key of the registry is an ErrorCode; the filter exists for the type checker. |
| worker | setup.ts:278 | `local === undefined ? def : { ...def, local }` → always spread | Adds `local: undefined` to a state without a local schema; the runtime only reads `def.local === undefined` (phases.ts `parseLocal`, step.ts initial check). |
| worker | journal-query.ts:113 | `query.order === "asc" ? "ASC" : …` → `""` | `ORDER BY seq` with no direction is ascending in SQLite. |
| worker | setup.ts:226 | `local === undefined ? def : { ...def, local }` → always spread | Adds `local: undefined` to a state without a local schema; the runtime only reads `def.local === undefined` (phases.ts `parseLocal`, step.ts initial check). |

## Bugs found while hardening (2026-10-07)

| Package | Bug | Test |
|---|---|---|
| client | Reconnect gave up after 10 attempts; no reconnect on `online`/visible; a socket replaced by disconnect()/connect() could still reconnect or overwrite the view; disconnect() during getToken() still opened a socket; a rejected getToken() stalled forever; a JSON snapshot left the replaced binary view's checksum to be sent | `client-reconnect-resilience.test.ts` (11 red before) |
| client | `actorClient(contract)` threw on create() when `def.views` was not an object | `client-native-and-builder.test.ts` |
| core | Nullable fields inside nested schemas / arrays of schemas were dropped from deltas | `core-delta-nested-nullable.test.ts` |
| studio | `Upgrade: WebSocket` (capital W) got a 426 | `studio-server-ws-upgrade.test.ts` |
| studio UI | computeDiff treated inherited keys (`toString`, `constructor`) as present | `studio-ui-diff.mutation.test.tsx` |
| studio UI | Malformed known frames lost the failing field path in the error | `studio-ui-state.mutation.test.ts` |
| worker | `actor.ts` compared `Upgrade` case-sensitively, same as the studio bug (fixed on the ADR-015 branch) | `websocket-upgrade.test.ts` (unit, red before); `websocket.test.ts` (workerd lowercases it, so the integration test passed either way) |
| worker | A lifecycle connect/disconnect that only scheduled or cancelled a timer was not committed | `timers.test.ts` "lifecycle handlers" (red before) |

## Bugs found in the bug bash (2026-10-10)

| Package | Bug | Test |
|---|---|---|
| worker | A link push's version was `Date.now()`, so a source that woke (in-memory dedupe gone) and pushed its unchanged view on a re-subscribe passed the subscriber's monotonic check: `link.onUpdate` ran and was journaled again. The version is now the source's `snapshots.last_seq` (`snapshotSeq()`, journal on or off). Links are also stored and pushed under the actor type (`lobby`), not the binding name (`LOBBY`). | `link-versions.test.ts` (6 red before); `outbox-store.test.ts` "snapshotSeq". Stryker on `journal.ts` `snapshotSeq` / `nextTransitionSeq`: 9/9 killed (100%). `pnpm crap:worker`: no new function ≥ 8 (the 6 at or above 8 are the same before and after the fix). |
## Studio on phones (2026-10-10)

Bug bash: every Studio page scrolled sideways at phone widths and most controls were under 40px.
Fix: `packages/studio/ui/src/components/phone.ts` (`TAP` = `max-sm:min-h-10`, `SCROLL_X` = `overflow-x-auto`),
16px side gutter below `sm`, wide tables and the tab bar scroll in their own box, phone-only wrapping of the
dashboard forms. Desktop screenshots at 1280px are pixel-identical before and after (apart from live data).

| Gate | Result |
|---|---|
| `tests/e2e-studio/studio-mobile.spec.ts` (375×667, 280×653) | 6 red before (dashboard +132/+227px, actor pages +236/+331px, tap targets 20-38px), 6 green after |
| Stryker, the 13 changed UI files (whole files, 608 mutants) | 91.26% (489 killed, 54 timeout, 52 survived, 13 errors); `studio-ui-panels.mutation.test.tsx` then killed 5 real survivors (timer and restore labels, emitted-name separator, timers clock cleanup), confirmed by a scoped re-run: 92.10% (548/595). The other 47 are equivalent: 37 class strings and colour tables, 2 React keys, 7 cause-label fallbacks, 1 effect deps (table above) |
| CRAP `packages/studio/ui/src` | max 7.0, 0 functions ≥ 8 (`EntryDetails` was 8.0 before: its two compound conditions became `hasEmitted` / `bothHaveState`) |
