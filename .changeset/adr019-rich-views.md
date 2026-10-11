---
"@actor-kit/core": minor
"@actor-kit/client": minor
---

Richer view schemas (ADR-019 C): `int8`/`int16`/`int32`, `enumOf([...])`/`literal(v)`, `record(T)`, `union(tag, variants)` and `json(zodSchema)`, all inferred by `Infer<>` and nestable. Deltas send only the removed, changed and added keys of a record and only the changed fields of an unchanged union variant. The 1e-6 delta tolerance now applies to float fields only.
