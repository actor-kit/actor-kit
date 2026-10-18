# Binary Wire Protocol

## Overview

Actor Kit v2 replaces JSON Patch with schema-aware binary delta encoding. The `schema()` builder defines the binary layout at compile time. The encoder sends only changed fields using a bitmask. The decoder on the client reconstructs the view.

## Frame format

Every WebSocket frame starts with a 6-byte header (`frame.ts`):

```
Byte 0: version (uint8) — schema version, used for version negotiation
Byte 1: type (uint8) — frame type
Bytes 2-5: length (uint32, big-endian) — payload length in bytes
```

### Frame types

| Type | Value | Direction | Description |
|------|-------|-----------|-------------|
| SNAPSHOT | 0x01 | server → client | Full state, all fields |
| DELTA | 0x02 | server → client | Changed fields only |
| MESSAGE | 0x03 | client → server | Event from client |
| CONTROL | 0x04 | server → client | Framework control (redirect, error, schema_changed) |
| ACK | 0x05 | server → client | Message acknowledged |

### SNAPSHOT frame

Sent on first connect, reconnect with unknown checksum, or schema version change.

```
[header: 4 bytes]
[checksum: 8 bytes (xxhash64 of the payload)]
[role: uint8 (role index)]
[field_count: uint16]
[field_data...]
```

Each field is encoded according to its schema type:
- `uint8`: 1 byte
- `uint16`: 2 bytes (big-endian)
- `uint32`: 4 bytes (big-endian)
- `int8`, `int16`, `int32`: 1, 2, 4 bytes, two's complement, big-endian
- `float32`: 4 bytes (IEEE 754)
- `float64`: 8 bytes (IEEE 754)
- `boolean`: 1 byte (0x00 or 0x01)
- `string`: [varint byte length][utf-8 bytes]
- `array(T)`: [varint count][element_0][element_1]...
- `schema({...})`: fields encoded in definition order (nested)
- `nullable(T)`: one bit in the enclosing schema's null bitmask; a null value has no bytes
- `enumOf([...])` / `literal(v)`: the value's index in the list: 0 bytes for one value (`literal`), 1 byte up to 256 values, 2 bytes (big-endian) up to 65536. Encoding a value outside the list, or decoding an index outside it, throws.
- `record(T)`: [varint count] then per entry [varint key length][utf-8 key][T value], in the object's key order. Decoded with `Object.fromEntries`, so a key named `__proto__` stays a key.
- `union(tag, { name: schema({...}), ... })`: [uint8 variant index (declaration order)][the variant's fields as a nested schema]. Decodes to `{ [tag]: name, ...fields }`, tag first. At most 256 variants; a variant may not declare the tag field.
- `json(zodSchema)`: [varint length][utf-8 JSON text]. The client parses the text, then the Zod schema (a failure keeps the last good view). `undefined` is sent as `null`.

**Lengths and counts are varints.** Every string byte length, record key length, JSON text length,
array count and record count is an unsigned LEB128 varint: 7 bits per byte, low bits first, the high
bit set on every byte but the last (0-127 take one byte, 128-16383 two, ...). A decoder refuses one
longer than 8 bytes. There is no size limit below what a frame holds. Fixed-width numbers (`uint16`,
`int32`, `float64`, an enum index, ...) stay big-endian.

| Length | Bytes |
|---|---|
| 3 | `03` |
| 127 | `7f` |
| 128 | `80 01` |
| 300 | `ac 02` |
| 16384 | `80 80 01` |

### DELTA frame

Sent after a transition when the view has changed for a specific caller.

```
[header: 4 bytes]
[checksum: 8 bytes (new checksum)]
[bitmask: ceil(field_count / 8) bytes]
[changed_field_data...]
```

The bitmask has one bit per top-level field in the view schema. Bit N = 1 means field N's new value follows in the payload. Bit N = 0 means field N is unchanged, no data.

Example: view schema has 10 fields. Bitmask = 2 bytes. If only field 2 (float32) changed:
```
Bitmask: 0b00000100 0b00000000  (2 bytes)
Data: [float32 value]           (4 bytes)
Total: 4 (header) + 8 (checksum) + 2 (bitmask) + 4 (data) = 18 bytes
```

Compared to JSON Patch for the same change: `[{"op":"replace","path":"/x","value":1.5}]` = ~48 bytes + JSON encoding overhead.

### Values inside a delta

A changed field's value is encoded as in a snapshot, except records and unions, which send what
changed inside them. The decoder takes the same branch from the value it already holds (the
checksum protocol guarantees it holds the server's previous view), so no flag says which branch
was taken, except the record mode byte.

**record(T)**

```
[mode: uint8]
mode 1 (patch):
  [removed count: varint][removed keys: varint length + utf-8 each]
  [changed count: varint][per key: key, then T's delta against the old value]
  [added count: varint][per key: key, then T's full value]
mode 0 (whole): the record exactly as in a snapshot
```

Patching keeps kept keys in their old order and appends added keys, so the encoder sends the whole
record when that would not reproduce the next value's key order (the client's checksum is computed
over the view's JSON). A `null` previous value patches as an empty record.

**union(tag, variants)**

```
[variant index: uint8]
same variant as the previous value: [change bitmask][null bitmask][changed fields] (the top-level layout, over the variant's fields)
another variant (or previous null):  the variant's fields as in a snapshot
```

Nested records and unions inside a record value or a variant field recurse the same way. Arrays,
nested `schema()` values, `json` and primitives are resent whole.

**Change detection**: float32/float64 values within 1e-6 are equal (float32 precision loss);
every other value compares exactly (objects and arrays as JSON text).

### Array delta strategy

Phase 1: entire array re-sent if any element changes. The bitmask marks the array field as changed, and the full array is encoded.

Phase 2 (future): per-element tracking with element identity. Array delta frame includes:
```
[array_field_index: uint16]
[operation_count: uint16]
[operations...]
  Each operation:
    [op: uint8 (0=set, 1=insert, 2=remove)]
    [index: uint16]
    [element_data (for set/insert)]
```

### MESSAGE frame (client → server)

```
[header: 4 bytes]
[message_type_length: uint8]
[message_type: utf-8 string]
[payload: JSON-encoded bytes]
```

Client messages are JSON (not binary) because:
1. Client messages are infrequent compared to server broadcasts
2. JSON is easier to debug
3. Zod validation expects JS objects
4. The bottleneck is server→client bandwidth, not client→server

### CONTROL frame

```
[header: 4 bytes]
[control_type: uint8]
[control_payload...]
```

| Control type | Value | Payload |
|-------------|-------|---------|
| REDIRECT | 0x01 | [actor_type_len: uint8][actor_type: string][actor_id_len: uint8][actor_id: string] |
| SCHEMA_CHANGED | 0x02 | Followed by a SNAPSHOT frame with new schema version |
| ERROR | 0x03 | [message_type_len: uint8][message_type: string][code_len: uint8][code: string][detail_len: uint16][detail: string] |
| ROLE_CHANGED | 0x04 | [new_role: uint8] followed by SNAPSHOT |

## Change tracking

Phase 1 uses diff-based change tracking:

```
1. Transition produces new state
2. For each connected caller:
   a. Compute new view: viewFn(newState, caller)
   b. Compare each top-level field with previous view
   c. Build bitmask of changed fields
   d. Encode only changed fields
   e. Send DELTA frame
```

Comparison is by value for primitives, by reference + deep equality for objects/arrays. The view function returns a new object each time, so reference comparison happens at the field level, not the root level.

## Checksum

The checksum is the xxHash64 (seed 0, 16 lowercase hex chars) of the view's JSON — `xxh64(JSON.stringify(view))` from `@actor-kit/core`, computed identically by the server and the client. It serves two purposes:
1. **Deduplication**: if the checksum hasn't changed since the last send, skip the frame entirely
2. **Reconnection and resync**: the client sends `{"type":"__reconnect","lastChecksum"}` when a socket
   reopens, and on an open socket after a frame it could not decode (ADR-020 D). The server answers
   `__reconnect_ack` when its current view has that checksum, else a full SNAPSHOT. (Every new socket
   also gets a SNAPSHOT first, before the client's `__reconnect` arrives.)

## Lengths are exact

A frame must carry at least the payload bytes its header promises (`parseFrame` throws
`invalid_frame` "Frame cut short" otherwise). `decode` and `applyDelta` must consume the payload
exactly: one that ends early or has bytes left over is `invalid_frame`. Most view schema changes
(a field added, removed or retyped) change the byte layout, so a client decoding with an older
schema finds out instead of showing a wrong value; the client then asks for the view again and, if
that fails too, reports `invalid_frame` through `onError` so the app can reload.

## Heartbeat

While a socket is open the client sends the text `{"type":"__ping"}` every 20 s (and at once on
page visible / browser online); the actor registers `setWebSocketAutoResponse` so the runtime
answers `{"type":"__pong"}` without waking it. A ping with no frame of any kind within 5 s abandons
the socket (ADR-020 A, B).

## Schema changes across a deploy

There is no schema negotiation on the wire: the frame's version byte is the actor's state
`version`, and `ControlType.SCHEMA_CHANGED` is reserved but never sent. A deploy restarts the actor,
which closes every socket; clients reconnect and get a SNAPSHOT in the new schema. A client bundle
that is older than the new schema is caught by the exact-length rule above in most cases (a change
that keeps every byte length is not).
