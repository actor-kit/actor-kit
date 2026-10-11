---
"@actor-kit/worker": minor
"@actor-kit/core": minor
"@actor-kit/studio": minor
---

ADR-019 D: journal archive to R2. `journal: { keep, archive: "R2_BINDING" }` writes what pruning removes to the bucket as NDJSON segments (`actorType/actorId/<fromSeq>-<toSeq>.ndjson`: base checkpoint, checkpoints, events) before deleting it locally, recorded in a new `journal_archive` table. Restore and `rebuild: "replay"` fetch the segments they need; `readFullJournal(sql, bucket, { from })` merges archived and local rows for replay and analysis. A failed put deletes nothing. Studio shows the archived and local ranges and the object's storage, warning at 80% of the 10 GB per-object limit. New error codes: `archive_unbound`, `archive_missing`, `invalid_archive_segment`. Website: a "History (the journal)" concept page.
