# Phase 2: Binary Sync — Specification

## Goal

Replace JSON snapshot sync with schema-aware binary encoding. After this phase, WebSocket frames are binary: full snapshots on first connect, bitmask-based deltas on subsequent updates.

## Prerequisites

Phase 1 complete. JSON sync working end-to-end.

## Deliverables

### 1. Binary encoder

**File**: `packages/core/src/encode.ts`

```typescript
function encode<T extends SchemaDefinition>(schema: T, data: Infer<T>): Uint8Array;
function encodeDelta<T extends SchemaDefinition>(schema: T, prev: Infer<T>, next: Infer<T>): Uint8Array | null;
```

Requirements:
- `encode()` produces a SNAPSHOT frame payload (all fields)
- `encodeDelta()` produces a DELTA frame payload (bitmask + changed fields), or `null` if nothing changed
- Field encoding follows schema type: uint8 → 1 byte, float32 → 4 bytes, string → length-prefixed UTF-8, etc.
- Fields encoded in definition order (deterministic)
- Nested schemas encoded recursively
- Arrays: `[uint16 count][element_0][element_1]...`
- Big-endian byte order for multi-byte integers

### 2. Binary decoder

**File**: `packages/core/src/decode.ts`

```typescript
function decode<T extends SchemaDefinition>(schema: T, bytes: Uint8Array): Infer<T>;
function applyDelta<T extends SchemaDefinition>(schema: T, current: Infer<T>, bytes: Uint8Array): Infer<T>;
```

Requirements:
- `decode()` reads a SNAPSHOT payload → typed object
- `applyDelta()` reads a DELTA payload, applies changed fields to current state → new object
- Immutable: `applyDelta` returns a new object, doesn't mutate `current`
- Decoder must be browser-safe (ships in `@actor-kit/core`, used by `@actor-kit/client`)
- Handles malformed input gracefully (throws typed error, doesn't crash)

### 3. Frame framing

**File**: `packages/core/src/frame.ts`

```typescript
function createSnapshotFrame(version: number, checksum: bigint, role: number, payload: Uint8Array): Uint8Array;
function createDeltaFrame(version: number, checksum: bigint, payload: Uint8Array): Uint8Array;
function createControlFrame(controlType: ControlType, payload: Uint8Array): Uint8Array;
function parseFrame(bytes: Uint8Array): Frame;
```

Frame header: 4 bytes (version: uint8, type: uint8, length: uint16).

### 4. Change detection (diff-based)

**File**: `packages/worker/src/runtime/diff.ts`

```typescript
function diffViews<T extends SchemaDefinition>(
  schema: T,
  prev: Infer<T>,
  next: Infer<T>,
): ChangedFields;
```

Requirements:
- Compare each top-level field by value (primitives) or deep equality (objects/arrays)
- Return a bitmask + list of changed field indices
- Used by runtime to decide whether to send DELTA or skip

### 5. Integrate with runtime

Update `packages/worker/src/actor.ts` to:
- Send binary SNAPSHOT frames on WebSocket connect
- Send binary DELTA frames after transitions
- Skip frames when checksum matches (no changes)
- Handle CONTROL frames (redirect, schema_changed, error)

### 6. Checksum computation

**File**: `packages/core/src/checksum.ts`

Requirements:
- xxhash64 of the full SNAPSHOT payload
- Stored per caller in memory (last N checksums for reconnect delta)
- Compared before sending: if checksum unchanged, skip frame

## Acceptance criteria

1. WebSocket frames are binary (not JSON)
2. SNAPSHOT frame on first connect decodes to correct typed view
3. DELTA frame after transition contains only changed fields
4. Unchanged state produces no WebSocket frame (checksum dedup)
5. Round-trip: encode → decode === original data for all schema types
6. Delta: encode → applyDelta === full re-encode → decode
7. Client bundle adds < 3KB for decoder
8. Position update (3x float32) is < 25 bytes total frame size
