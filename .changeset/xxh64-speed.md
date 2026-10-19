---
"@actor-kit/core": patch
---

xxh64 runs on 32-bit integer arithmetic instead of BigInt, with the same output. The state checksum every transition journals is about 4× faster: simulate() on a peekaboo-sized state went from 1,972 to 478 µs per message, and the Durable Object pays less CPU per transition.
