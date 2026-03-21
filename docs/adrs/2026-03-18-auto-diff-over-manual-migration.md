# Auto-Diff Migration over Manual Version+Migrate

**Date**: 2026-03-18
**Status**: Accepted
**Deciders**: Jonathan Mumm

## Context

When persisted actor snapshots become stale (machine definition changed between deployments), actor-kit needs to migrate them to the new shape. Two approaches exist in the ecosystem:

1. **Auto-diff** (xstate-migrate): Spin up a fresh actor from the current machine definition, diff its snapshot against the persisted one, apply structural changes automatically. No version numbers, no manual migration code.

2. **Manual version+migrate** (@xstate/store persist): Store a version number alongside persisted data. On load, compare versions and run a user-supplied `migrate(persisted, fromVersion)` function.

## Decision

Keep xstate-migrate's auto-diff approach. Do not adopt the version+migrate pattern from @xstate/store.

### Why

XState machines are **executable schema definitions**. You can always instantiate a fresh actor and ask "what would a brand new snapshot look like?" then diff from there. This is strictly better than manual migration for structural changes:

- **Zero bookkeeping** — no version numbers to manage, no migration chain to maintain
- **Less code to get wrong** — auto-diff handles additions, removals, and type changes automatically
- **No stale migration functions** — manual migrate chains accumulate over time and are rarely tested for the full v1→vN path

The version+migrate pattern exists in @xstate/store because **stores lack structural introspection**. A store's context is a plain object — there's no way to instantiate a "fresh reference" and diff against it. It's the same reason database migrations need version numbers: SQL schemas aren't diffable at runtime. xstate-migrate gets to skip versioning because machines *are* diffable.

### When manual migration is still needed

Auto-diff only handles **structural** changes (new fields, removed fields, type changes). It cannot handle **semantic** migrations:

- Renaming a field (looks like remove + add, not rename)
- Splitting one field into two
- Transforming values (e.g., `string` → `string[]`)

For semantic migrations, the machine's `MIGRATE` system event handler is the right place. The machine receives the event on snapshot restore and can transform context in the transition.

## Formal Verification (TLA+)

These claims were verified with TLC across exhaustive state spaces. Specs live in `docs/tlaplus/`.

### MigrationStrategies.tla — Structural changes (4,096 states)

All 3 fields × 4 types (including absent) × 2 schema versions. **7 invariants verified:**

| Invariant | Result | Meaning |
|-----------|--------|---------|
| AutoDiffTypeSafe | **Pass** | Every field in result matches V2 schema type |
| AutoDiffPreservesValues | **Pass** | Same-type fields keep their persisted value |
| AutoDiffRemovesDropped | **Pass** | Fields absent in V2 are removed |
| AutoDiffAddsNew | **Pass** | Fields new in V2 get defaults |
| AutoDiffOnlyV2Fields | **Pass** | No phantom fields from V1 leak through |
| AutoDiffNeverKeepsWrongType | **Pass** | Type-changed fields always get fresh defaults |
| AutoDiffMatchesCorrectManual | **Pass** | Auto-diff = correct manual migration for structural changes |
| ManualBuggyTypeSafe | **Violated** (expected) | A buggy migrate function produces type-unsafe state |

### MigrationRename.tla — Rename edge case (729 states)

| Invariant | Result | Meaning |
|-----------|--------|---------|
| AutoDiffLosesRenameValue | **Pass** | Auto-diff cannot preserve values across renames |
| ManualPreservesRenameValue | **Pass** | Correct manual migration can preserve rename values |
| AutoDiffRemovesOldField | **Pass** | Old field name is cleaned up |

**Confirms**: auto-diff is correct but incomplete for renames. The MIGRATE event handler is the right escape hatch.

### MigrationMultiHop.tla — Multi-version skipping (4,096 states)

Snapshot persisted under V1, machine evolved V1→V2→V3. Auto-diff only sees V1 vs V3.

| Invariant | Result | Meaning |
|-----------|--------|---------|
| DirectTypeSafe | **Pass** | Direct V1→V3 diff produces valid types |
| StepwiseTypeSafe | **Pass** | Stepwise V1→V2→V3 also produces valid types |
| AgreeOnTypes | **Pass** | Both strategies produce the same types |
| AgreeOnPresence | **Pass** | Both strategies agree on which fields exist |
| FullyAgree | **Violated** | Values can differ (see below) |

**Counterexample**: V1 has FieldB:Int, V2 changes to FieldB:Str, V3 changes back to FieldB:Int.
- **Direct**: V1 and V3 both have FieldB:Int → same type → preserves V1 value (origin=1)
- **Stepwise**: V1→V2 type mismatch → default. V2→V3 type mismatch → default (origin=3). User data lost.

Direct auto-diff actually **preserves more data** than stepwise in this case. The "type changed back" scenario is a round-trip that stepwise migration destroys but direct migration survives. This strengthens the case for auto-diff: skipping intermediate versions is a feature, not a bug.

## Consequences

- `xstate-migrate` remains the primary migration mechanism for persisted actors
- No version numbers stored alongside snapshots
- Semantic migrations (renames, splits, transforms) go in the machine's `MIGRATE` event handler
- If actor-kit adds a `persist()` extension (014), it should use auto-diff internally, not expose a version+migrate API
- Auto-diff's "skip intermediate versions" behavior is verified correct and sometimes superior to stepwise migration
