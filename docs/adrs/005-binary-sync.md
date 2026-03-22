# ADR 005: Binary Schema Sync over JSON Patch

**Date**: 2026-03-22
**Status**: Accepted

## Context

Actor Kit v1 used JSON Patch (RFC 6902) for state synchronization. Problems:
- Verbose: a position update `{"op":"replace","path":"/x","value":1.5}` is ~48 bytes for 4 bytes of data.
- Parse overhead: JSON.parse + JSON.stringify on every frame.
- No type awareness: patches are generic — the client doesn't know field types until runtime.
- Array patches are fragile: index-based patches break if the array changes between patch generation and application.

## Decision

Replace JSON Patch with schema-aware binary delta encoding. The `schema()` builder defines the wire format at compile time.

### schema() builder

```typescript
const MyView = schema({
  x: float32,
  y: float32,
  name: string,
  health: uint32,
});
```

This provides:
1. **TypeScript type inference**: `Infer<typeof MyView>` = `{ x: number; y: number; name: string; health: number }`
2. **Binary layout**: field order, types, sizes are known at compile time
3. **StandardSchemaV1 interface**: interop with Zod, Valibot, ArkType ecosystem
4. **Encoder/decoder**: `encode(MyView, data)` → `Uint8Array`, `decode(MyView, bytes)` → typed object

### Delta encoding

A bitmask indicates which fields changed. Only changed field data follows.

Position update (x and y changed):
```
Header:     4 bytes
Checksum:   8 bytes
Bitmask:    1 byte  (0b00000011 — fields 0 and 1)
x (float32): 4 bytes
y (float32): 4 bytes
Total:      21 bytes
```

Same update as JSON Patch: ~100 bytes (two patch operations, JSON encoded).

### Change detection

Phase 1: diff-based. Compare previous view output to new view output, field by field.
- Simple to implement
- O(fields) per transition — fine for views with < 100 fields
- Views are projections (smaller than full state)

Phase 2 (future): proxy-based change tracking for high-frequency updates (MMO).

## Consequences

- ~5-10x bandwidth reduction for typical state updates.
- Client needs a decoder — adds ~2KB to client bundle (schema metadata + decoder).
- Schema must be shared between server and client (same npm package, subpath exports).
- Schema changes require version negotiation (see binary-protocol.md).
- The `schema()` builder is a new concept users must learn. But it replaces manual type definitions — net simplification.
- Fallback for complex cases: `output()` escape hatch for raw binary (MMO position streaming).
