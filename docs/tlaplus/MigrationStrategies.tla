---- MODULE MigrationStrategies ----
EXTENDS TLC, FiniteSets, Integers, Sequences

(*
 * Formal verification of auto-diff vs manual migration strategies
 * for persisted state machine snapshots.
 *
 * Models:
 *   - Schema evolution: fields added, removed, type-changed, renamed
 *   - Auto-diff: instantiate fresh snapshot from current schema, diff against persisted
 *   - Manual: version number + user-supplied migrate function chain
 *
 * We want to find cases where either strategy silently produces wrong results.
 *)

\* --------------------------------------------------------------------------
\* CONSTANTS AND MODEL VALUES
\* --------------------------------------------------------------------------

\* Field names that can appear in schemas
CONSTANTS FieldA, FieldB, FieldC

\* Field types
CONSTANTS TypeInt, TypeStr, TypeBool

\* Special marker for "no value" / field absent
CONSTANTS Absent

\* All possible field names
AllFields == {FieldA, FieldB, FieldC}

\* All possible types
AllTypes == {TypeInt, TypeStr, TypeBool}

\* A value is a <<type, data>> pair. Data is abstract — we just track type + identity.
\* We model values as records: [type |-> T, origin |-> V]
\* where origin tracks which schema version produced the value (for traceability).
\* "default" origin means it came from a fresh schema default.

\* --------------------------------------------------------------------------
\* SCHEMA AND SNAPSHOT DEFINITIONS
\* --------------------------------------------------------------------------

\* A Schema maps field names to types (or Absent if field doesn't exist in schema).
\* Schema == [AllFields -> AllTypes \union {Absent}]

\* A Snapshot maps field names to [type |-> T, origin |-> O] or Absent.
\* Snapshot == [AllFields -> [type: AllTypes, origin: Nat] \union {Absent}]

\* --------------------------------------------------------------------------
\* VARIABLES
\* --------------------------------------------------------------------------

VARIABLES
    schemaV1,          \* Schema the snapshot was persisted under
    schemaV2,          \* Current schema (what we're migrating TO)
    persistedSnapshot, \* Snapshot persisted under schemaV1
    autoDiffResult,    \* Result of auto-diff migration
    manualResult,      \* Result of manual migration (correct chain)
    manualBuggyResult, \* Result of manual migration (buggy/missing step)
    done

vars == <<schemaV1, schemaV2, persistedSnapshot, autoDiffResult,
          manualResult, manualBuggyResult, done>>

\* --------------------------------------------------------------------------
\* HELPERS
\* --------------------------------------------------------------------------

\* Create a snapshot with default values for a given schema.
\* Default value for a field of type T at schema version V:
DefaultValue(t, version) == [type |-> t, origin |-> version]

\* Create a default snapshot from a schema at a given version number.
FreshSnapshot(schema, version) ==
    [f \in AllFields |-> IF schema[f] = Absent
                         THEN Absent
                         ELSE DefaultValue(schema[f], version)]

\* --------------------------------------------------------------------------
\* AUTO-DIFF ALGORITHM
\* --------------------------------------------------------------------------

\* Auto-diff logic:
\*   For each field:
\*     - If fresh has it and persisted doesn't: ADD (use fresh default)
\*     - If persisted has it and fresh doesn't: REMOVE
\*     - If both have it and SAME type: KEEP persisted value
\*     - If both have it and DIFFERENT type: REPLACE with fresh default (type mismatch)

AutoDiff(persisted, freshSnap) ==
    [f \in AllFields |->
        IF freshSnap[f] = Absent
        THEN Absent  \* Field not in current schema -> remove
        ELSE IF persisted[f] = Absent
             THEN freshSnap[f]  \* New field -> use default
             ELSE IF persisted[f].type = freshSnap[f].type
                  THEN persisted[f]  \* Same type -> keep persisted value
                  ELSE freshSnap[f]  \* Type changed -> use default
    ]

\* --------------------------------------------------------------------------
\* MANUAL MIGRATION (correct)
\* --------------------------------------------------------------------------

\* A correct manual migration knows the semantic intent.
\* For structural changes, it does the same as auto-diff.
\* For renames, it can carry the value over.
\* We model the "correct" case as: produces the ideal result.

\* The ideal result for each field:
\*   - If field exists in V2 schema: should have V2 type
\*   - If field existed in V1 with same type: keep V1 value
\*   - If field is new in V2: default value
\*   - If field type changed: default value (unless semantic transform exists)
\*   - If field was removed: absent

\* For a correct manual migration, the result is identical to auto-diff
\* for structural changes. The difference only shows for renames.
\* We model correct manual = auto-diff (for structural changes).
ManualCorrect(persisted, schema2) ==
    AutoDiff(persisted, FreshSnapshot(schema2, 2))

\* --------------------------------------------------------------------------
\* MANUAL MIGRATION (buggy: missing step)
\* --------------------------------------------------------------------------

\* Buggy manual migration: the migrate function has a bug.
\* We model this as: it forgets to handle one field's type change,
\* leaving the old-typed value in place.

ManualBuggy(persisted, schema2) ==
    \* Pick the "first" field that changed type and forget to migrate it
    LET fresh == FreshSnapshot(schema2, 2)
        changedFields == {f \in AllFields :
            /\ persisted[f] /= Absent
            /\ fresh[f] /= Absent
            /\ persisted[f].type /= fresh[f].type}
    IN
    IF changedFields = {}
    THEN AutoDiff(persisted, fresh)  \* No type changes -> correct
    ELSE
        LET buggyField == CHOOSE f \in changedFields : TRUE
        IN [f \in AllFields |->
            IF f = buggyField
            THEN persisted[f]  \* BUG: kept old value with wrong type!
            ELSE AutoDiff(persisted, fresh)[f]
        ]

\* --------------------------------------------------------------------------
\* INIT AND NEXT
\* --------------------------------------------------------------------------

Init ==
    \* Non-deterministically choose two schemas (V1 and V2)
    \* Each schema assigns each field a type or Absent
    /\ schemaV1 \in [AllFields -> AllTypes \union {Absent}]
    /\ schemaV2 \in [AllFields -> AllTypes \union {Absent}]
    \* Persisted snapshot was created from V1
    /\ persistedSnapshot = FreshSnapshot(schemaV1, 1)
    /\ autoDiffResult = Absent
    /\ manualResult = Absent
    /\ manualBuggyResult = Absent
    /\ done = FALSE

Compute ==
    /\ ~done
    /\ LET fresh == FreshSnapshot(schemaV2, 2) IN
       /\ autoDiffResult' = AutoDiff(persistedSnapshot, fresh)
       /\ manualResult' = ManualCorrect(persistedSnapshot, schemaV2)
       /\ manualBuggyResult' = ManualBuggy(persistedSnapshot, schemaV2)
       /\ done' = TRUE
       /\ UNCHANGED <<schemaV1, schemaV2, persistedSnapshot>>

Finished ==
    /\ done
    /\ UNCHANGED vars

Next == Compute \/ Finished

Spec == Init /\ [][Next]_vars

\* --------------------------------------------------------------------------
\* INVARIANTS
\* --------------------------------------------------------------------------

\* P1: Auto-diff result has correct types for all present fields
\* (every field in result matches the V2 schema type)
AutoDiffTypeSafe ==
    done => \A f \in AllFields :
        \/ autoDiffResult[f] = Absent
        \/ (schemaV2[f] /= Absent /\ autoDiffResult[f].type = schemaV2[f])

\* P2: Auto-diff preserves values when field exists in both with same type
AutoDiffPreservesValues ==
    done => \A f \in AllFields :
        (/\ persistedSnapshot[f] /= Absent
         /\ schemaV2[f] /= Absent
         /\ persistedSnapshot[f].type = schemaV2[f])
        => autoDiffResult[f] = persistedSnapshot[f]

\* P3: Auto-diff removes fields not in V2 schema
AutoDiffRemovesDropped ==
    done => \A f \in AllFields :
        schemaV2[f] = Absent => autoDiffResult[f] = Absent

\* P4: Auto-diff adds fields new in V2 with defaults
AutoDiffAddsNew ==
    done => \A f \in AllFields :
        (/\ schemaV1[f] = Absent
         /\ schemaV2[f] /= Absent)
        => (autoDiffResult[f] /= Absent /\ autoDiffResult[f].origin = 2)

\* P5: Auto-diff result only contains fields defined in V2 schema
AutoDiffOnlyV2Fields ==
    done => \A f \in AllFields :
        (autoDiffResult[f] /= Absent) => (schemaV2[f] /= Absent)

\* P6: Buggy manual migration CAN produce type-unsafe results
\* (We expect this to be violated — that's the point)
ManualBuggyTypeSafe ==
    done => \A f \in AllFields :
        \/ manualBuggyResult[f] = Absent
        \/ (schemaV2[f] /= Absent /\ manualBuggyResult[f].type = schemaV2[f])

\* P7: Auto-diff matches correct manual for structural changes
AutoDiffMatchesCorrectManual ==
    done => autoDiffResult = manualResult

\* --------------------------------------------------------------------------
\* EDGE CASE: Field removed in V2, then we check V3 where it's re-added
\* with a different type. We model this as V1 has field with TypeA,
\* V2 has field with TypeB. Auto-diff should use V2 default.
\* This is already covered by the non-deterministic schema choice above,
\* since schemaV1[f] and schemaV2[f] can be any type independently.
\* --------------------------------------------------------------------------

\* P8: Auto-diff handles type changes by using fresh default
\* (persisted value with wrong type is NEVER kept)
AutoDiffNeverKeepsWrongType ==
    done => \A f \in AllFields :
        (/\ autoDiffResult[f] /= Absent
         /\ persistedSnapshot[f] /= Absent
         /\ persistedSnapshot[f].type /= schemaV2[f])
        => autoDiffResult[f].origin = 2  \* Must be fresh default

====
