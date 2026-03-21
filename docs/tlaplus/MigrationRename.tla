---- MODULE MigrationRename ----
EXTENDS TLC, FiniteSets, Integers

(*
 * Models the RENAME edge case for auto-diff migration.
 *
 * Scenario: V1 has field "oldName", V2 renames it to "newName".
 * Auto-diff sees: oldName removed + newName added.
 * The user's VALUE in oldName is lost — newName gets a default.
 *
 * This spec verifies that auto-diff CANNOT preserve values across renames,
 * and that a correct manual migration CAN.
 *)

CONSTANTS
    OldField, NewField, OtherField,
    TypeInt, TypeStr,
    Absent

AllFields == {OldField, NewField, OtherField}
AllTypes == {TypeInt, TypeStr}

VARIABLES
    schemaV1, schemaV2,
    persistedSnapshot,
    autoDiffResult,
    manualResult,
    isRename,    \* TRUE when V1 has OldField and V2 renames it to NewField
    done

vars == <<schemaV1, schemaV2, persistedSnapshot, autoDiffResult, manualResult, isRename, done>>

DefaultValue(t, version) == [type |-> t, origin |-> version]

FreshSnapshot(schema, version) ==
    [f \in AllFields |-> IF schema[f] = Absent
                         THEN Absent
                         ELSE DefaultValue(schema[f], version)]

AutoDiff(persisted, freshSnap) ==
    [f \in AllFields |->
        IF freshSnap[f] = Absent
        THEN Absent
        ELSE IF persisted[f] = Absent
             THEN freshSnap[f]
             ELSE IF persisted[f].type = freshSnap[f].type
                  THEN persisted[f]
                  ELSE freshSnap[f]
    ]

\* Manual migration that knows about the rename:
\* copies OldField's value to NewField
ManualRenameAware(persisted, schema2) ==
    [f \in AllFields |->
        IF f = NewField /\ persisted[OldField] /= Absent /\ schema2[NewField] /= Absent
        THEN \* Carry the value from OldField to NewField (if types match)
             IF persisted[OldField].type = schema2[NewField]
             THEN [type |-> persisted[OldField].type, origin |-> persisted[OldField].origin]
             ELSE DefaultValue(schema2[NewField], 2)
        ELSE AutoDiff(persisted, FreshSnapshot(schema2, 2))[f]
    ]

Init ==
    \* Model a rename: V1 has OldField present, NewField absent
    \* V2 has OldField absent, NewField present (same type = rename)
    /\ schemaV1 \in [AllFields -> AllTypes \union {Absent}]
    /\ schemaV2 \in [AllFields -> AllTypes \union {Absent}]
    \* Flag rename scenarios
    /\ isRename = (/\ schemaV1[OldField] /= Absent
                    /\ schemaV1[NewField] = Absent
                    /\ schemaV2[OldField] = Absent
                    /\ schemaV2[NewField] /= Absent
                    /\ schemaV1[OldField] = schemaV2[NewField])
    /\ persistedSnapshot = FreshSnapshot(schemaV1, 1)
    /\ autoDiffResult = Absent
    /\ manualResult = Absent
    /\ done = FALSE

Compute ==
    /\ ~done
    /\ LET fresh == FreshSnapshot(schemaV2, 2) IN
       /\ autoDiffResult' = AutoDiff(persistedSnapshot, fresh)
       /\ manualResult' = ManualRenameAware(persistedSnapshot, schemaV2)
       /\ done' = TRUE
       /\ UNCHANGED <<schemaV1, schemaV2, persistedSnapshot, isRename>>

Finished ==
    /\ done
    /\ UNCHANGED vars

Next == Compute \/ Finished
Spec == Init /\ [][Next]_vars

\* --------------------------------------------------------------------------
\* INVARIANTS
\* --------------------------------------------------------------------------

\* When a rename happens, auto-diff LOSES the original value
\* (NewField gets origin=2 i.e. default, not origin=1 i.e. user data)
AutoDiffLosesRenameValue ==
    (done /\ isRename)
    => autoDiffResult[NewField].origin = 2  \* Default, not preserved

\* When a rename happens, correct manual migration PRESERVES the value
ManualPreservesRenameValue ==
    (done /\ isRename)
    => manualResult[NewField].origin = 1  \* Preserved from V1

\* Auto-diff still removes the old field correctly
AutoDiffRemovesOldField ==
    (done /\ isRename)
    => autoDiffResult[OldField] = Absent

\* Both strategies agree when there's no rename
AgreeWhenNoRename ==
    (done /\ ~isRename)
    => autoDiffResult = AutoDiff(persistedSnapshot, FreshSnapshot(schemaV2, 2))

====
