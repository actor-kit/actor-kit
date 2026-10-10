---
"@actor-kit/worker": major
"@actor-kit/studio": minor
"@actor-kit/studio-cli": minor
---

One history (ADR-017 §5): Studio's timeline is read from the actor journal.

- The `timeline` table and its writes are gone; migration `0015_drop_timeline` drops it. A timeline entry is a journal event (`id` = `seq`), its after-state taken from a checkpoint or replayed from the newest checkpoint before it, checksum-verified. An after-state that cannot be rebuilt (another code version, a pruned journal without a checkpoint before it, a diverging replay) is `null`; the UI says "State not available" and shows no diff, and the CLI shape reports no changed paths for it.
- `studio.timelineSize` is removed: journal retention (`journal: { keep }`) is the only retention. With `journal: false` the timeline is empty.
- Redaction is applied to the rebuilt entries through `runtime/studio-project.ts`, as before. Cursor pagination, live `studio.timeline` pushes and "restore to here" work as before.
