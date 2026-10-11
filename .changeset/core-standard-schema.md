---
"@actor-kit/core": minor
---

View schemas validate: every `schema()` and field type (including int8/16/32, enumOf/literal, record, union, json) implements StandardSchemaV1 (`~standard.validate`, vendor `actor-kit`) and has `parse(value)`, which throws a `SchemaValidationError` naming each issue's path. Values the wire format cannot hold (strings over 65535 UTF-8 bytes, arrays or records over 65535 entries) are rejected.
