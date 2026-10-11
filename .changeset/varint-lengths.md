---
"@actor-kit/core": minor
"@actor-kit/client": minor
---

Wire format: every length and count (strings, record keys, json text, arrays, records, record-delta counts) is an unsigned LEB128 varint instead of a big-endian uint16 (json: uint32). Strings over 65535 bytes no longer corrupt the frame, and large arrays and records round-trip. Server and client must both run 0.3.
