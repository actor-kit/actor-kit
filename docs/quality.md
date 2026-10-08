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
| test | 70.55% (115/163) | 98.17% (161/164) | 9.0 `sendWithEffectsImpl` (1) | 5.0 (0) |
| storybook | no tests (0%) | 100% (35/35) | 20.0 `send` (2) | 4.0 (0) |
| studio (server) | 75.58% (622/823) | 99.19% (732/738) | 42.0 middleware handler (6) | 7.0 `accessConfig`, `route` (0) |
| studio UI (`ui/src`) | 65.45% (896/1369) | 93.05% (1298/1395) | 19.2 `alignPrimitiveArrays` (12) | 7.0 `diffAt` (0) |
| studio-cli | 78.87% (362/459) | 99.28% (414/417) | 30.0 mcp tool handler (6) | 7.0 `get` (0) |

Notes:
- Survivors are equivalent mutants (table below). Remaining `as` casts in these packages: one commented
  `as Infer<SchemaDefinition<TShape>>` at each generic decode boundary in core (`decode`, `applyDelta`), where the
  compiler cannot relate a runtime walk over `fields` to the mapped type; and storybook's `trigger()`
  (`Object.assign({ type }, payload) as TEvent`), which takes an untyped name and payload by design.
- Studio UI: about 70 of its 97 survivors are Tailwind class strings and colour tables (styling only; every state
  they colour is also shown as text or `data-status`). They are grouped in one row below rather than listed.
- Stryker's incremental mode can keep stale "Survived" results for module-level mutants after new tests kill
  them. Delete `reports/stryker-<pkg>.incremental.json` (or pass `--force`) for final numbers.
- Studio's registry Durable Object runs under unit tests through `tests/unit/studio-server-fake-do.ts`, a thin
  `SqlStorage` fake over `node:sqlite`.

## Equivalent mutants

Surviving mutants that no test can kill, because the mutated program behaves identically. One line each.

| Package | Location | Mutant | Why it is equivalent |
|---|---|---|---|
| core | delta.ts:28 | `if (a === b) return true` → `if (false)` | Fast path only; the number and JSON comparisons below return the same result. |
| client | builder.ts:90 | `"name" in arg && "def" in arg` → `\|\|` | A SchemaDefinition has neither key, a contract has both. |
| client | builder.ts:99, 103 (×3) | `isRecord` / `isViewSchema` → `true` | A non-schema registered for a role makes decode throw, which the client catches and ignores, the same as having no schema. |
| client | builder.ts:116 | `if (isViewSchema(...))` → `true` | Registers `undefined` for the role; `viewSchemas[role] ?? viewSchema` falls back exactly as when it is absent. |
| client | client.ts:155, 156, 164 | `roleIndex === undefined ? …` / `roleName === undefined ? …` → `false` | parseFrame always sets roleIndex on snapshots, and indexing with `undefined` yields `undefined` anyway. |
| client | client.ts:179 | `onRedirect?.(…)` → `onRedirect(…)` | Binary path only: the TypeError is caught by handleBinaryMessage's try/catch, same as doing nothing. |
| client | client.ts:267 | `typeof data === "string"` → `true` | Non-string data fails JSON.parse (or parses to a non-object) and is ignored either way. |
| client | client.ts:377 | parseJson `catch { return undefined }` → `{}` | Returns `undefined` either way. |
| client | url.ts:25 | `lastColon >= 0` → `> 0` | Differs only for a host starting with `:`, which is `wss` either way. |
| react | context.ts:67 | `client.view !== undefined` → `true` | Only adds `setView(undefined)` when the state is already `undefined`. |
| react | context.ts:91 | `client.role !== role` → `true` | Setting the same state value is a React no-op. |
| react | context.ts:135 | effect deps `[client]` → `[]` | The client comes from a `useState` initializer and never changes. |
| test | test-actor.ts:143 | `typeof record !== "object" \|\| record === null` → `false` | A primitive role entry still yields no messages. |
| test | test-actor.ts:162 | `slots !== undefined` → `true` | The router treats an `undefined` role entry as "message not found" anyway. |
| test | test-actor.ts:356 | `if (def.observe)` → `true` | Assigns `undefined`, which `send` reads with optional chaining. |
| studio | access.ts:161 | `catch` block → `{}` | Falls through to the same 401 "Invalid Cloudflare Access token". |
| studio | middleware.ts:147 | `join(".")` → `join("")` | Every request schema's error paths have a single segment, so there is nothing to join. |
| studio | middleware.ts:237 (×3) | `rawType !== undefined && rawId !== undefined` → `\|\|` / `true` | Both regex groups are required, so a match always fills both; the check exists for the type checker. |
| studio | registry.ts:81 | `previousActorId !== actorId` → `true` | Deleting and re-inserting the same row in one transaction leaves an identical row. |
| studio-cli | cli.ts:50 | `actorType === undefined` → `false` | `actorId` is `undefined` whenever `actorType` is, so the same error is thrown. |
| studio-cli | client.ts:77 | `{ state: z.unknown() }` → `{}` | `z.unknown()` accepts a missing key; only the static type differs. |
| studio-cli | shape.ts:42 | `catch { return undefined }` → `{}` | Returns `undefined` either way. |
| studio UI | all components | ~70 className literals, colour tables (OUTBOX_STATUS_CLASS, SCALAR_CLASS, CAUSE_LABELS colours), status-badge pulse dot, active-tab class | Styling only; each state is also rendered as text or `data-status`. |
| studio UI | timeline-panel.tsx:9-11 | cause label entries → `[]` | The fallback label equals the cause type; only the colour differs. |
| studio UI | inspect-panels.tsx:116,142; actor-table.tsx:19; json-diff.tsx:41 | React key template → `""` | Keys only; no visible difference for distinct rows. |
| studio UI | actor-detail.tsx:13 | useParams `{ from }` → `{}` | Same params from the single matching route. |
| studio UI | actor-detail.tsx:15 | remount key → `""` | ActorTabs already unmounts on an actor switch because the hook resets `inspect` to null. |
| studio UI | compute-diff.ts:107,109 (×2) | prefix bound `Math.max` / `<=` / `true` | Reading past the end gives `undefined`, which never equals a JSON primitive, so the loop stops anyway. |
| studio UI | compute-diff.ts:126 | loop start `a.length - 1` → `+ 1` | Extra rows write out of bounds (ignored) or zeros; same result. |
| studio UI | api.ts:65 | `catch { return undefined }` → `{}` | Returns `undefined` either way. |
| studio UI | protocol.ts:17 | addIssue code `"custom"` → `""` | Same message. |
| studio UI | use-actor-list.ts:37,38,44 | empty catch, `[]` deps, initial `{ kind: "loading" }` | The effect sets loading before first paint; same behaviour. |

## Bugs found while hardening (2026-10-07)

| Package | Bug | Test |
|---|---|---|
| client | Reconnect gave up after 10 attempts; no reconnect on `online`/visible; a socket replaced by disconnect()/connect() could still reconnect or overwrite the view; disconnect() during getToken() still opened a socket; a rejected getToken() stalled forever; a JSON snapshot left the replaced binary view's checksum to be sent | `client-reconnect-resilience.test.ts` (11 red before) |
| client | `actorClient(contract)` threw on create() when `def.views` was not an object | `client-native-and-builder.test.ts` |
| core | Nullable fields inside nested schemas / arrays of schemas were dropped from deltas | `core-delta-nested-nullable.test.ts` |
| studio | `Upgrade: WebSocket` (capital W) got a 426 | `studio-server-ws-upgrade.test.ts` |
| studio UI | computeDiff treated inherited keys (`toString`, `constructor`) as present | `studio-ui-diff.mutation.test.tsx` |
| studio UI | Malformed known frames lost the failing field path in the error | `studio-ui-state.mutation.test.ts` |
| worker (not fixed, other session's scope) | `actor.ts` compares `Upgrade` case-sensitively, same as the studio bug | — |
