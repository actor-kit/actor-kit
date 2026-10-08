---
"@actor-kit/core": minor
"@actor-kit/worker": minor
"@actor-kit/studio": minor
---

Restore (ADR-015 D3, ADR-013 step 3): `__restore({ toSeq })` (Studio action `restore`, mutate scope) appends a `restore` event and puts the actor back to journal seq `toSeq`: the state is folded from the newest checkpoint at or before it (checksum-verified), the timers pending then come back with their original deadlines, effects declared only by undone transitions become dead letters with the reason, and service results recorded after `toSeq` are redelivered as new events without calling the service. `foldJournal`/`replayJournal` replay restore events. Checkpoints store the pending timers; service journal events carry their `effectId`; timeline entries carry their journal `seq`, and Studio offers "Restore to here" on them. On wake, a snapshot that lags the journal is rebuilt from it.
