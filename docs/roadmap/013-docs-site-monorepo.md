# 013: Docs Site + Monorepo + tsdown

**Priority**: P1
**Status**: Accepted (Phase 2 implemented 2026-03-19)
**Affects**: repo structure, build system, CI/CD, `actor-kit/website` repo

## Problem

Actor-kit's documentation and build infrastructure have several issues:

### 1. No docs site

Documentation lives in markdown files in `docs/` — useful for contributors but not discoverable by users. No search, no API reference, no versioning. The `actor-kit/website` repo exists but is a landing page, not a docs site.

### 2. No LLM-friendly output

AI coding assistants are a primary way developers discover and use libraries. There's no `.llms.txt`, no "Copy page for LLM" button, no structured output optimized for AI consumption.

### 3. Rollup build is heavyweight

The current build uses `rollup` + `rollup-plugin-typescript2` + `rollup-plugin-dts` + `@rollup/plugin-terser` with a 59-line config. Some entry points build to `dist/`, others point at raw `src/` TypeScript. Inconsistent and more config than value.

### 4. Split repos

The website (`actor-kit/website`) and library (`actor-kit/actor-kit`) are separate repos. Changes that affect both (API changes, new features) require coordinating across repos.

### 5. No package split path

The scoped packages (`@actor-kit/worker`, `@actor-kit/react`, etc.) benefit from a monorepo with workspace tooling that makes cross-package coordination trivial.

## Proposed Solution

### Phase 1: tsdown migration (standalone, no monorepo needed)

Replace Rollup with [tsdown](https://tsdown.dev/) — an esbuild-based bundler by the Vite/Rspack team that reads `exports` from package.json and auto-generates builds.

#### Before (rollup.config.js — 59 lines)

```javascript
import terser from "@rollup/plugin-terser";
import { dts } from "rollup-plugin-dts";
import typescript from "rollup-plugin-typescript2";

const createConfig = (input, output, format = "es", isReact = false) => [
  {
    input,
    output: { file: output, format, sourcemap: true, banner: isReact ? '"use client";\n' : "" },
    external: [/* ... */],
    plugins: [typescript({ /* ... */ }), terser({ compress: { directives: false } })],
    onwarn(warning, warn) { /* ... */ },
  },
  {
    input,
    output: { file: output.replace(".js", ".d.ts"), format: "es" },
    external: ["cloudflare:workers", "@cloudflare/workers-types"],
    plugins: [dts()],
  },
];

export default [
  ...createConfig("src/browser.ts", "./dist/browser.js"),
  ...createConfig("src/react.ts", "./dist/react.js", "es", true),
  ...createConfig("src/index.ts", "./dist/index.js"),
];
```

#### After (tsdown.config.ts — ~15 lines)

```typescript
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    browser: "src/browser.ts",
    react: "src/react.ts",
    server: "src/server.ts",
    worker: "src/worker.ts",
    test: "src/test.ts",
    storybook: "src/storybook.ts",
  },
  format: "esm",
  dts: true,
  sourcemap: true,
  external: [
    "cloudflare:workers",
    "@cloudflare/workers-types",
    "react",
    "xstate",
    "zod",
  ],
  banner: {
    // "use client" directive for React entry points
    "react.js": '"use client";',
  },
});
```

Benefits:
- All 7 entry points built consistently to `dist/`
- DTS generation built-in (no separate `rollup-plugin-dts`)
- `"use client"` directive support built-in
- Near-instant builds (esbuild-based)
- 5 fewer devDependencies (`rollup`, `rollup-plugin-dts`, `rollup-plugin-typescript2`, `@rollup/plugin-terser`, `rollup-plugin-preserve-directives`)

### Phase 2: Monorepo conversion

Move the library into `packages/` and bring the website in as `apps/docs`:

```
actor-kit/
├── packages/
│   └── actor-kit/                    (library)
│       ├── src/
│       ├── tests/
│       ├── tsdown.config.ts
│       └── package.json
├── apps/
│   └── docs/                         (Starlight docs site)
│       ├── src/
│       │   ├── content/
│       │   │   └── docs/             (MDX pages)
│       │   └── components/
│       ├── astro.config.mjs
│       └── package.json
├── examples/
│   ├── tanstack-start-actorkit-todo/
│   └── nextjs-actorkit-todo/
├── pnpm-workspace.yaml
├── turbo.json                        (or similar task runner)
├── CLAUDE.md
└── package.json                      (root)
```

#### pnpm-workspace.yaml

```yaml
packages:
  - "packages/*"
  - "apps/*"
  - "examples/*"
```

#### Turborepo (optional but nice for caching)

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

### Phase 3: Starlight docs site

[Starlight](https://starlight.astro.build/) is an Astro-based documentation framework.

#### Why Starlight

- Static output → deploys to CF Pages (you already deploy `actor-kit/website` there)
- MDX — existing `docs/*.md` files port directly
- Built-in search (Pagefind), sidebar, dark mode, i18n, versioning
- [starlight-llms-txt](https://github.com/nicepkg/starlight-llms-txt) plugin auto-generates `.llms.txt`
- Minimal JS shipped to client (Astro islands)
- Active community, well-maintained

#### Site structure

```
apps/docs/src/content/docs/
├── index.mdx                      (home — moved from README overview)
├── getting-started/
│   ├── installation.mdx
│   ├── quick-start.mdx            (TanStack Start walkthrough)
│   └── concepts.mdx               (key concepts, architecture)
├── guides/
│   ├── tanstack-start.mdx         (full integration guide)
│   ├── nextjs.mdx
│   ├── storybook.mdx              (mock client patterns)
│   └── testing.mdx                (E2E and unit testing)
├── api/
│   ├── worker.mdx                 (createMachineServer, createActorKitRouter)
│   ├── server.mdx                 (createAccessToken, createActorFetch)
│   ├── browser.mdx                (createActorKitClient)
│   ├── react.mdx                  (createActorKitContext, hooks)
│   ├── test.mdx                   (createActorKitMockClient)
│   └── storybook.mdx              (withActorKit decorator)
├── architecture/
│   ├── overview.mdx               (from docs/architecture.md)
│   ├── sync-protocol.mdx          (checksum, JSON Patch, reconnection)
│   ├── persistence.mdx            (snapshots, SQLite, event sourcing)
│   └── decisions/                  (ADRs)
│       ├── checksum-sync.mdx
│       ├── public-private-context.mdx
│       ├── jwt-auth.mdx
│       └── xstate-core.mdx
└── roadmap.mdx                    (links to GitHub roadmap)
```

#### LLM-friendly features

1. **`.llms.txt`** — auto-generated by `starlight-llms-txt` plugin. A single file containing all docs in plain text, optimized for AI context windows.

2. **"Copy page for AI" button** — custom Starlight component:
   ```astro
   <!-- src/components/CopyForAI.astro -->
   <button id="copy-ai" title="Copy page content for AI assistant">
     📋 Copy for AI
   </button>
   <script>
     document.getElementById('copy-ai')?.addEventListener('click', () => {
       const content = document.querySelector('.sl-markdown-content');
       navigator.clipboard.writeText(content?.textContent ?? '');
     });
   </script>
   ```

3. **`/llms-full.txt`** — full docs dump at a known URL for tools like `@anthropic-ai/claude-code` to fetch.

#### Deployment

```yaml
# .github/workflows/docs.yml
name: Deploy Docs
on:
  push:
    branches: [main]
    paths: ["apps/docs/**", "packages/actor-kit/src/**"]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install
      - run: pnpm --filter docs build
      - uses: cloudflare/wrangler-action@v3
        with:
          command: pages deploy apps/docs/dist --project-name=actor-kit-docs
```

Auto-deploys on merge to main whenever docs or library source changes.

### Phase 4: Package split (future, optional)

Once the monorepo is set up, splitting into scoped packages becomes straightforward:

```
packages/
├── actor-kit/          → actor-kit (types + schemas, unchanged)
├── worker/             → @actor-kit/worker
├── browser/            → @actor-kit/browser
├── react/              → @actor-kit/react
├── server/             → @actor-kit/server
├── test/               → @actor-kit/test
└── storybook/          → @actor-kit/storybook
```

**Not recommended yet** — the coordination overhead isn't worth it at current scale. But the monorepo structure makes it a one-day task when the time comes. See the earlier analysis in this conversation for the full pros/cons.

## Implementation Plan

### Phase 1: tsdown (1 PR)

1. `pnpm add -D tsdown`
2. Create `tsdown.config.ts`
3. Update `package.json` scripts: `"build": "tsdown"`
4. Update `exports` in `package.json` — all point to `dist/`
5. Remove Rollup devDependencies
6. Delete `rollup.config.js`
7. Verify `pnpm build && pnpm typecheck && pnpm test:unit`
8. Verify examples still work with new build output

### Phase 2: Monorepo (1 PR)

9. Create `pnpm-workspace.yaml`
10. Move library to `packages/actor-kit/`
11. Move examples to `examples/` (already there)
12. Consolidate integration tests: migrate old Miniflare tests (`tests/integration/`) to `@cloudflare/vitest-pool-workers` and merge with `tests/workers/`. Single `test:integration` command runs all DO integration tests via the Workers pool.
13. Update CI workflows for monorepo paths
14. Update import paths in tests and examples
15. Verify all feedback commands still work

### Phase 3: Starlight docs (1 PR)

15. `pnpm create astro -- --template starlight` in `apps/docs/`
16. Port `docs/*.md` content to `apps/docs/src/content/docs/`
17. Port README API reference to individual pages
18. Add `starlight-llms-txt` plugin
19. Add "Copy for AI" component
20. Add CF Pages deployment workflow
21. Update README to link to docs site

### Phase 4: Package split (future, separate initiative)

22. Split packages if/when needed (not part of this proposal)

## Test Plan

### tsdown

1. **All entry points produce dist/ output** — `ls dist/*.js dist/*.d.ts` shows all 7
2. **React entry has "use client" banner** — `head -1 dist/react.js` contains directive
3. **DTS files are valid** — `tsc --noEmit` passes against dist types
4. **Examples build against new dist** — both TanStack and Next.js examples compile
5. **Bundle size comparable or smaller** — compare `du -sh dist/` before/after
6. **All existing tests pass** — no behavior change

### Monorepo

7. **Root `pnpm test` runs all workspace tests**
8. **Root `pnpm build` builds library then examples**
9. **CI runs correctly with workspace paths**
10. **`pnpm --filter actor-kit build` works standalone**

### Docs site

11. **`pnpm --filter docs build` produces static output**
12. **`.llms.txt` generated at build time**
13. **All internal links resolve (no broken links)**
14. **Search works (Pagefind indexes all pages)**
15. **CF Pages deploy succeeds**
16. **"Copy for AI" button copies page text to clipboard**
