---
"@actor-kit/worker": minor
"@actor-kit/studio": minor
---

ADR-018 E: determinism in production. Actors take `determinism: "throw" | "warn" | "off"` (default `"warn"`): in warn mode a handler that reads the clock or randomness directly gets the real value, one `actor_kit.handler.nondeterministic` line is logged and the journal entry is flagged `nondeterministic` (migration `0019_nondeterministic`; Studio's timeline shows a badge); `"throw"` fails the transition as tests do. A Biome GritQL plugin ships at `@actor-kit/worker/biome/no-nondeterminism.grit` and flags `Date.now`, `new Date()`, `Math.random` and `crypto.randomUUID` inside handler bodies.
