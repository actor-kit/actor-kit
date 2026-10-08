# Binary Wire Protocol

## Overview

Actor Kit v2 replaces JSON Patch with schema-aware binary delta encoding. The `schema()` builder defines the binary layout at compile time. The encoder sends only changed fields using a bitmask. The decoder on the client reconstructs the view.

## Frame format

Every WebSocket frame starts with a 4-byte header:

```
Byte 0: version (uint8) — schema version, used for version negotiation
Byte 1: type (uint8) — frame type
Bytes 2-3: length (uint16, big-endian) — payload length in bytes
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
- `float32`: 4 bytes (IEEE 754)
- `float64`: 8 bytes (IEEE 754)
- `boolean`: 1 byte (0x00 or 0x01)
- `string`: [uint16 length][utf-8 bytes]
- `array(T)`: [uint16 count][element_0][element_1]...
- `schema({...})`: fields encoded in definition order (nested)

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
2. **Reconnection**: client sends its last checksum on reconnect, server uses it to compute a delta

## Schema version negotiation

```
Client connects:
  → Sends { lastChecksum, schemaVersion } in first WS message

Server checks schemaVersion:
  Match → proceed normally (DELTA if checksum known, SNAPSHOT if not)
  Mismatch → send SCHEMA_CHANGED control frame + full SNAPSHOT in new schema

Mid-session deploy:
  → Server detects schema version changed
  → Sends SCHEMA_CHANGED + SNAPSHOT to all connected clients
  → Clients re-initialize their decoders
```

The client SDK handles this transparently. User code sees a new view arrive — it doesn't need to know about schema negotiation.
