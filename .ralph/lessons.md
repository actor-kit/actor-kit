# Lessons
Patterns and mistakes. Review at start of each iteration.
---
- The old site (~/src/actor-kit/website/src/pages/index.astro) used a CUSTOM StarlightPage, not the default splash template. The custom page has hand-crafted HTML/CSS for hero, features, and tabbed code.
- Starlight's built-in splash template uses CardGrid which looks generic. For a compelling homepage, use a custom page component.
- The v1 site's orange color scheme (#f6821f) with dark background looks professional. Keep the same palette.
- Tabbed code examples are the killer feature of the v1 homepage — they show the full stack in one glance.
- The docs dev server runs at http://localhost:4321
- Use mcp__claude-in-chrome tools to take screenshots and interact with the page
- Function parameter contravariance (strict mode) prevents typed role predicates from being assignable to ActorDef's bivariant interface. Use a type guard (`isActorDef`) instead of `as` cast to bridge the gap in createActorClass.
- `@actor-kit/worker/testing` entrypoint avoids cloudflare:workers — use it for unit-testable exports like defineActor.
- New files default to tabs; biome wants spaces. Run `biome check --fix` on new files before committing.
- Integration tests need `pnpm build` in packages/worker before they pick up new exports (wrangler resolves from dist/).
- Guard type change from `(state) => boolean` to `(state, payload, ctx) => boolean` is backward compatible: TS allows fewer-param functions to be assigned to more-param types, and JS ignores extra args. But ActorMessageSlot/RoutableMessage bivariant method signatures MUST also be updated — a 3-param function is NOT assignable to a 1-param function type (even with bivariance).
- When detecting flat vs role-nested messages, check ALL entries for both `schema` AND `handler` properties. Checking only the first entry or only `schema` creates false positives when role names collide with MessageDef property names.
- When removing a feature that spans multiple packages with dual actor.ts files (actor-kit + worker), remember to update BOTH copies — and also the test harness packages (packages/test, packages/actor-kit/src/test). The codex review catches stale references in test files.
- CREATE_TABLES_SQL must be kept in sync with persistOutbox() — unused columns in the schema are a migration hazard flagged by codex.
