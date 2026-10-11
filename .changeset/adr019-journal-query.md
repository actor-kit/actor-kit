---
"@actor-kit/worker": minor
"@actor-kit/studio": minor
"@actor-kit/studio-cli": minor
---

Journal query (ADR-019 F): the `__journal({ from, to, before, causeType, event, correlationId, limit, order })` Studio RPC returns journal entries with their cause, emitted events (marked `published`), correlation and causation ids, redacted per ADR-014. Exposed as `GET /__studio/api/actors/:type/:id/journal`, `actor-kit studio journal <type> <id>` (with `--shape`) and the `studio_journal` MCP tool.
