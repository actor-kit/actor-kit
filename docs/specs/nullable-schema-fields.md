# Nullable Schema Fields

**Status:** Proposed
**Motivation:** State models routinely have "no value yet" semantics (`lastUpdatedBy: string | null`, `winner: PlayerId | null`, `kicker: Card | null`). Today the binary schema has no way to express this — fields are non-nullable, forcing actors to use sentinel values (`""`, `0`) that collide with real data.

## Background

Today's encoder (`packages/core/src/binary.ts`, `delta.ts`) is **schema-driven and not self-describing**: when the schema says `string`, the encoder writes a length-prefixed UTF-8 blob with no type tag. The decoder knows the type because the schema says so at that field position. There is no room for `null` in the wire format.

Symptoms in practice:
- `examples/counter` declares `lastUpdatedBy: string` in the view but `lastUpdatedBy: null` in `init()` — the type system catches it, but the workaround is to use `""` as a "no one yet" sentinel.
- Any actor with optional state (e.g. card-game `winner`, auction `currentBidder`, chat `lastMessage`) has the same problem.

## Goals

1. **Per-field nullability** declared via a `nullable()` combinator.
2. **Wire-efficient:** 1 bit per nullable field, no type tags on values.
3. **Type-safe:** `Infer<>` produces `T | null` for nullable fields.
4. **Additive:** existing schemas keep working unchanged. No migration.

## Non-Goals

- No general `optional` (i.e. `T | undefined`). Pick one — `null` — and stick with it. Reject `undefined` at the projection boundary. Document the convention in JSDoc on `nullable()`.
- No type-tagged self-describing values (Colyseus/MessagePack style). That's a bigger architectural change; this spec stays inside actor-kit's schema-driven model.

## Design

### `nullable()` combinator

New field descriptor in `packages/core/src/schema.ts`:

```ts
interface NullableDescriptor<F extends FieldDescriptor> {
  readonly kind: "nullable";
  readonly type: "nullable";
  readonly field: F;
}

export function nullable<F extends FieldDescriptor>(field: F): NullableDescriptor<F>;
```

Add `"nullable"` to the `FieldDescriptor` union. `Infer<>` unwraps:

```ts
type InferField<F extends FieldDescriptor> =
  F extends NullableDescriptor<infer Inner>
    ? InferField<Inner> | null
    : /* existing cases */;
```

Usage:

```ts
import { nullable, string, uint32, schema } from "@actor-kit/core";

const CounterView = schema({
  count: uint32,
  lastUpdatedBy: nullable(string),
});

// Infer<typeof CounterView> = { count: number; lastUpdatedBy: string | null }
```

### Wire format change

Today's frame layout (snapshot and delta) carries a **field-presence bitmask** indicating which fields are written. Add a parallel **null bitmask** of the same width.

```
[ versionByte ]
[ frameType   ]
[ presentMask : N bits ]
[ nullMask    : N bits ]   ← NEW (only present if schema has any nullable fields)
[ field 0 bytes (if present and not null) ]
[ field 1 bytes (if present and not null) ]
...
```

Decoder logic per field:

```
if (presentMask & bit) {
  if (nullMask & bit) {
    value = null;
    // zero bytes consumed
  } else {
    value = decodeField(buffer);
  }
}
```

Encoder logic per field:

```
if (fieldChanged) {
  presentMask |= bit;
  if (value === null) {
    nullMask |= bit;
    // skip writing value bytes
  } else {
    encodeField(value, buffer);
  }
}
```

**Schemas with zero nullable fields skip the null mask entirely** — no overhead, no wire change for existing actors. Detect at schema-build time: walk fields once, set a `hasNullable: boolean` on the `SchemaDefinition`.

### Bitmask width

Same as the existing presence mask: capped at 32 fields per schema for now (fits in a `uint32`). Document the limit. If we ever exceed it, fall back to a `Uint8Array` mask in a follow-up.

### Delta semantics

Three states for a nullable field across two frames:

| Prev | Next | presentMask bit | nullMask bit | bytes written |
|---|---|---|---|---|
| `"alice"` | `"alice"` | 0 (unchanged) | — | 0 |
| `"alice"` | `"bob"`   | 1 | 0 | length-prefixed `"bob"` |
| `"alice"` | `null`    | 1 | 1 | 0 |
| `null`    | `"alice"` | 1 | 0 | length-prefixed `"alice"` |
| `null`    | `null`    | 0 (unchanged) | — | 0 |

The diff layer (`delta.ts`) compares prev vs next and treats `null !== "alice"` as a change like any other.

## Test Plan (TDD)

### Unit tests (`tests/unit/`)

1. `nullable.test.ts`
   - `nullable(string)` returns a NullableDescriptor wrapping a string primitive.
   - `Infer<>` of `schema({ x: nullable(string) })` is `{ x: string | null }`.
   - Primitives: `nullable(uint32)`, `nullable(boolean)` infer correctly.
   - Nested schemas: `nullable(schema({ x: uint32 }))` infers `{ x: number } | null`.
   - Arrays: `nullable(array(uint32))` infers `number[] | null`.
   - Schema build sets `hasNullable: true` when any field is nullable.
   - Schema with no nullable fields has `hasNullable: false` — confirms zero overhead path.

2. `encoder-nullable.test.ts`
   - Snapshot encode of `{ x: null }` with schema `{ x: nullable(string) }` → present bit set, null bit set, zero value bytes.
   - Snapshot encode of `{ x: "hi" }` → present bit set, null bit clear, length-prefixed string follows.
   - Round-trip: encode → decode produces structurally equal object including `null` values.
   - Nullable nested schema: `{ card: null }` with `nullable(schema({ suit: string, rank: uint8 }))` — null bit set, zero sub-field bytes.
   - Nullable array: `{ items: null }` with `nullable(array(uint32))` — null bit set, no count prefix, no element bytes.
   - Schema with no nullable fields produces a frame with no null mask (byte-for-byte identical to current encoder output — regression test).

3. `delta-nullable.test.ts`
   - prev `"a"` → next `"a"`: field omitted from delta (present bit clear).
   - prev `"a"` → next `"b"`: present bit set, null bit clear, `"b"` written.
   - prev `"a"` → next `null`: present bit set, null bit set, zero bytes.
   - prev `null` → next `"a"`: present bit set, null bit clear, `"a"` written.
   - prev `null` → next `null`: field omitted (no change).

### Integration tests (`tests/integration/`)

4. `nullable-view.test.ts` (vitest-pool-workers)
   - Actor with `lastUpdatedBy: nullable(string)` in its view, initial state `null`.
   - Connect a client, assert first snapshot decodes `{ count: 0, lastUpdatedBy: null }`.
   - Send a message that sets `lastUpdatedBy = "alice"`; assert next delta updates correctly.
   - Send a message that sets it back to `null`; assert delta carries the null transition.

5. `examples/counter` migration test
   - Update `examples/counter` to use `nullable(string)` for `lastUpdatedBy`.
   - Existing integration tests for counter should still pass with no other changes.

### Mutation testing (Stryker)

6. Run Stryker against `packages/core/src/schema.ts`, `binary.ts`, `delta.ts`. Expected weak spots:
   - Inverted null check (`value === null` vs `value !== null`).
   - Off-by-one in null mask bit position.
   - Forgetting to clear null bit when transitioning `null → value`.
   - Forgetting to skip value-byte read when null bit is set in decoder (would corrupt subsequent fields — tests should catch via round-trip).

## Risks & Open Questions

- **`null` vs `undefined`:** Resolved — `null` only. `undefined` values in projection output should be rejected at the projection boundary (runtime error). Document in JSDoc on `nullable()`.
- **Wire backward compatibility:** clients connected with an old decoder will mis-parse frames from a schema that gained nullable fields. Mitigation: bump the schema `version` field on the actor when adding `nullable()` to an existing field. Document this in the migration notes.
- **`hasNullable` detection cost:** schema build walks all fields once. O(n) at startup, n = field count. Negligible.

## Rollout

1. Land `nullable()` combinator + `Infer<>` updates + `hasNullable` flag on schema definition. No encoder change yet.
2. Land encoder/decoder changes for snapshot frames with null mask. Tests #1, #2.
3. Land delta encoder/decoder changes. Test #3.
4. Land integration test #4.
5. Migrate `examples/counter` to use `nullable(string)` for `lastUpdatedBy`. Test #5.
6. Update docs Quick Start to reflect the new pattern.
7. Mutation test pass. Kill survivors.

## Why not type-tagged values (MessagePack/Colyseus style)?

Colyseus prefixes every value with a type byte (NIL = 0xc0, etc.), which makes `null` "just another type." This is elegant but costs 1 byte per field per frame and requires reworking the entire encoder to be self-describing. Actor-kit's wire format is schema-driven by design — the schema is the type oracle, not the bytes. A 1-bit-per-nullable-field mask preserves that property and is strictly cheaper. If we ever need full polymorphism (sum types, runtime-discriminated unions on the wire), that's a separate, larger spec.

## References

- Current schema builder: `packages/core/src/schema.ts`
- Current encoder: `packages/core/src/binary.ts`
- Current delta encoder: `packages/core/src/delta.ts`
- Frame layout: `packages/core/src/frame.ts`
- Companion spec: `docs/specs/view-split-and-fanout-cache.md` (`view.shared` / `view.perCaller` + fan-out cache)
- Counter example bug that motivated this: `examples/counter` Quick Start — `lastUpdatedBy` declared `string` in schema but `null` in init.
