---
"@actor-kit/projection": minor
---

New package (ADR-019 E): `projection({ queue, db, apply, reset })` is a Cloudflare Queue consumer that applies the events actors publish into a D1 read model once and in `position` order per actor (duplicates acked, gaps buffered in D1, each event atomic with its cursor), and `rebuild()` replays actor journals through the journal query (`actorJournalSource`, `studioJournalSource`) into a fresh read model with the same positions.
