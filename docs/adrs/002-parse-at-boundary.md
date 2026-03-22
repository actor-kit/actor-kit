# ADR 002: Parse at the Boundary

**Date**: 2026-03-22
**Status**: Accepted

## Context

Actor Kit processes data from multiple untrusted sources:
- WebSocket messages from clients (event type + payload)
- HTTP requests (spawn input, JWT tokens)
- DO RPC calls from other actors
- Persisted state from SQLite (may be from an older schema version)

Each source is a trust boundary. Data crossing a boundary can be malformed, malicious, or simply outdated.

## Decision

All data crossing a trust boundary is parsed through a schema before entering application logic. "Parse, don't validate" — parsing transforms untyped data into typed data, rejecting anything that doesn't fit.

### Boundaries and their schemas

| Boundary | Parser | What it validates |
|----------|--------|-------------------|
| Client WebSocket message | Zod (per-role message schema) | Event type exists for role, payload matches |
| HTTP spawn input | Zod (actor's `input` schema) | Input shape matches definition |
| JWT token | `jose` + custom validation | Signature, expiry, claims (sub, jti, aud) |
| Persisted state | `schema()` decoder + `migrate()` | State shape matches current version |
| DO RPC payload | Zod (rpc handler schema) | Payload matches expected shape |
| Binary WebSocket frame | Frame header validation | Version, type, length bounds |

### Rules

1. **Invalid data is rejected, never coerced.** A missing field is an error, not a default value. A wrong type is an error, not a cast.
2. **Parsing happens once, at the edge.** After parsing, data is trusted. Internal function calls don't re-validate.
3. **Parse results are typed.** `z.infer<typeof schema>` gives the TypeScript type. No `as` casts needed after parsing.
4. **Use `safeParse`, not `parse`.** Framework code uses `safeParse` and handles errors explicitly. Throwing Zod errors leaks internal details.

### How to apply

When adding a new data path:
1. Identify the trust boundary (where does this data come from?)
2. Define a Zod schema or use `schema()` decoder
3. Parse at entry, reject on failure
4. Pass typed result to internal functions

## Consequences

- Every external data path has a schema. No "just trust the JSON" shortcuts.
- Error messages from parse failures are structured and safe to return to clients.
- Runtime validation has a small performance cost, but it's at the boundary only — not on every internal call.
- Migration (`migrate()`) runs on persisted state because stored data is also an untrusted boundary (the schema may have changed since it was stored).
