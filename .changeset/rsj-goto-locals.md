---
"@actor-kit/worker": minor
"@actor-kit/core": minor
---

`ctx.goto(target, shared, input, { locals })` (and `ctx.reenter`) change the locals of the levels a transition keeps while it switches their child, typed per level by dotted path (ADR-019 A rows 21-22, new error code `invalid_goto_locals`). A child's `enter` may update the levels above it through `ctx.stay(shared, { ...ctx.local, ...ownLocal })` (row 23); a local with only its own keys leaves them as they were.
