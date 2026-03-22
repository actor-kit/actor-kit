# ADR 006: Single Package with Subpath Exports

**Date**: 2026-03-22
**Status**: Accepted

## Context

Actor Kit v1 was split into 9 packages (`@actor-kit/core`, `@actor-kit/browser`, `@actor-kit/react`, etc.). This was necessary because `@actor-kit/core` imported `cloudflare:workers`, which can't ship to browsers.

v2 redesigns the module boundaries so the CF runtime code lives only in the root export, while client/react/test exports have no CF dependencies.

## Decision

Single published package: `actor-kit` with subpath exports.

```json
{
  "name": "actor-kit",
  "exports": {
    ".":        { "types": "./dist/core/index.d.ts", "import": "./dist/core/index.js" },
    "./client": { "types": "./dist/client/index.d.ts", "import": "./dist/client/index.js" },
    "./react":  { "types": "./dist/react/index.d.ts", "import": "./dist/react/index.js" },
    "./test":   { "types": "./dist/test/index.d.ts", "import": "./dist/test/index.js" }
  }
}
```

### Why single package

1. **Schema sharing**: the binary encoder (server) and decoder (client) use the same schema definitions. One package means `import { MyView } from "./shared"` — no cross-package dependency dance.
2. **Type flow**: `actor()` produces types that client, React, and test all consume. One package = simple imports.
3. **Version coordination**: one changeset, one version number. No "is @actor-kit/react 3.2.1 compatible with @actor-kit/core 3.2.0?" questions.
4. **Subpath exports give the same guarantees**: `actor-kit/client` never imports `cloudflare:workers`. Bundlers tree-shake correctly.

### Why v1 had to split

`@actor-kit/core` mixed the `ActorLogic` interface (needed by client types) with `createDurableActor` (needs `cloudflare:workers`). Importing core for types pulled in the CF runtime. v2 separates these concerns at the module level within a single package.

## Consequences

- Users install one package: `pnpm add actor-kit`
- Server code: `import { actor, schema, view } from "actor-kit"`
- Client code: `import { connect } from "actor-kit/client"`
- React code: `import { createContext } from "actor-kit/react"`
- Test code: `import { testActor } from "actor-kit/test"`
- Shared types flow naturally between exports without cross-package versioning
