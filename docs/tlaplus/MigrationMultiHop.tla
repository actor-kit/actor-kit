---- MODULE MigrationMultiHop ----
EXTENDS TLC, FiniteSets, Integers

(*
 * Models the MULTI-HOP edge case.
 *
 * Scenario: Snapshot persisted under V1. Machine evolved V1 -> V2 -> V3.
 * Auto-diff only sees V3 (current) vs persisted (V1). It skips V2 entirely.
 *
 * Question: Can skipping intermediate versions cause auto-diff to produce
 * a different result than migrating through each step?
 *
 * Key concern: V2 added FieldB (with TypeInt). V3 changed FieldB to TypeStr.
 * If auto-diff sees V1 snapshot (no FieldB) against V3 schema (FieldB: TypeStr),
 * it correctly adds FieldB with TypeStr default.
 *
 * But what if V2's migration was supposed to populate FieldB from FieldA's value?
 * (semantic migration) Auto-diff can't know this. The question is whether
 * STRUCTURAL auto-diff is still correct in multi-hop scenarios.
 *)

CONSTANTS
    FieldA, FieldB,
    TypeInt, TypeStr, TypeBool,
    Absent

AllFields == {FieldA, FieldB}
AllTypes == {TypeInt, TypeStr, TypeBool}

VARIABLES
    schemaV1, schemaV2, schemaV3,
    persistedSnapshot,
    \* Auto-diff: directly compare V1 snapshot against V3 schema
    directResult,
    \* Step-by-step: auto-diff V1->V2, then auto-diff V2->V3
    stepwiseResult,
    done

vars == <<schemaV1, schemaV2, schemaV3, persistedSnapshot,
          directResult, stepwiseResult, done>>

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

Init ==
    /\ schemaV1 \in [AllFields -> AllTypes \union {Absent}]
    /\ schemaV2 \in [AllFields -> AllTypes \union {Absent}]
    /\ schemaV3 \in [AllFields -> AllTypes \union {Absent}]
    /\ persistedSnapshot = FreshSnapshot(schemaV1, 1)
    /\ directResult = Absent
    /\ stepwiseResult = Absent
    /\ done = FALSE

Compute ==
    /\ ~done
    /\ LET
         freshV2 == FreshSnapshot(schemaV2, 2)
         freshV3 == FreshSnapshot(schemaV3, 3)
         \* Direct: V1 snapshot against V3 schema
         direct == AutoDiff(persistedSnapshot, freshV3)
         \* Stepwise: V1->V2, then V2->V3
         intermediate == AutoDiff(persistedSnapshot, freshV2)
         stepwise == AutoDiff(intermediate, freshV3)
       IN
       /\ directResult' = direct
       /\ stepwiseResult' = stepwise
       /\ done' = TRUE
       /\ UNCHANGED <<schemaV1, schemaV2, schemaV3, persistedSnapshot>>

Finished ==
    /\ done
    /\ UNCHANGED vars

Next == Compute \/ Finished
Spec == Init /\ [][Next]_vars

\* --------------------------------------------------------------------------
\* INVARIANTS
\* --------------------------------------------------------------------------

\* Both direct and stepwise produce type-safe results (all fields match V3 schema)
DirectTypeSafe ==
    done => \A f \in AllFields :
        \/ directResult[f] = Absent
        \/ (schemaV3[f] /= Absent /\ directResult[f].type = schemaV3[f])

StepwiseTypeSafe ==
    done => \A f \in AllFields :
        \/ stepwiseResult[f] = Absent
        \/ (schemaV3[f] /= Absent /\ stepwiseResult[f].type = schemaV3[f])

\* KEY QUESTION: Do direct and stepwise always agree on final types?
\* (They may disagree on origin/values, but must agree on structure)
DirectAndStepwiseAgreeOnTypes ==
    done => \A f \in AllFields :
        /\ (directResult[f] = Absent) = (stepwiseResult[f] = Absent)
        /\ (directResult[f] /= Absent /\ stepwiseResult[f] /= Absent)
           => directResult[f].type = stepwiseResult[f].type

\* Do they agree on which fields are present?
DirectAndStepwiseAgreeOnPresence ==
    done => \A f \in AllFields :
        (directResult[f] = Absent) = (stepwiseResult[f] = Absent)

\* STRONGER: Do they agree on EVERYTHING (including origin)?
\* This might fail — and if it does, the counterexample is interesting.
DirectAndStepwiseFullyAgree ==
    done => directResult = stepwiseResult

====
