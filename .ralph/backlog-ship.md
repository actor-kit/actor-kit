# Ship-Ready Nightshift Backlog

Duration: 8 hours. Goal: everything needed to publish @actor-kit/* v0.1.0.

## Packages to publish
@actor-kit/core, @actor-kit/worker, @actor-kit/client, @actor-kit/react, @actor-kit/test, @actor-kit/storybook

## Tasks

- [x] **1. Fix storybook type errors** — The withActorKit.ts has createElement return type issues (ReactNode). Fix the type errors in packages/storybook/src/withActorKit.ts. Rebuild: `cd packages/storybook && pnpm build`. Run `pnpm typecheck`.

- [x] **2. Fix any remaining type/test failures** — Run `pnpm typecheck && pnpm test:unit && pnpm test:integration`. Fix ALL failures. The runtime fixes from the previous agents may have introduced issues (supportsBinary flag, binary capability detection). Ensure everything compiles and passes.

- [x] **3. Build all packages** — Run `pnpm build` in the root. Verify all 6 packages produce dist/ with correct files. Check each package's dist/ against its package.json exports.

- [ ] **4. TanStack Start example** — Create `examples/tanstack-start-counter/` with a full TanStack Start + Cloudflare Workers app. Reference ~/src/actor-kit/examples/tanstack-start-xstate-todo for patterns. The example should: define a counter actor with defineActor, serve SSR with TanStack Start, hydrate on client with actorClient + actorContext, deploy as a single CF Worker. Include wrangler.jsonc, package.json, tsconfig.json. Use withCallerIdentity for auth. The key value: shows the full production pattern (SSR + client hydration + WebSocket + typed hooks).

- [ ] **5. E2E tests for all examples** — Verify all 4 existing examples' Playwright tests pass. Start each example with `wrangler dev`, run its Playwright tests. Fix any failures. Also add E2E tests for the TanStack Start example if created. The tests should run against actual deployed workers, not mocks.

- [ ] **6. CI/CD pipeline** — Set up GitHub Actions workflow in .github/workflows/. Should: install deps, typecheck, unit test, integration test, build all packages, deploy examples as preview (wrangler pages deploy or wrangler deploy --env preview). Reference ~/src/actor-kit/.github/workflows/ for patterns. Changesets should handle versioning and npm publish on merge to main.

- [ ] **7. E2E tests against deployed workers** — Update playwright.config.ts to support running against deployed preview URLs (not just localhost). CI should: deploy examples → run Playwright against deployed URL → report results. This proves the examples actually work in production.

- [ ] **8. Final verification + changeset** — Run full suite: typecheck, unit tests (318+), integration tests (44+), E2E tests, lint, docs build. Create initial changeset for v0.1.0. Run `pnpm changeset` to create the changeset file. Commit everything.

- [ ] **9. Docs final pass** — Verify all 26 docs pages show correct @actor-kit/* imports, v3 API patterns, Worker-trust auth. Build docs site. Check landing page.

- [ ] **10. Codex review** — Run final codex review on the entire codebase. Address any P1/P2 findings. This is the last gate before publish.
