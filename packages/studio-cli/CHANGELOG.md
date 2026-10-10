# @actor-kit/studio-cli

## 0.2.0

First v2 pre-release, published under the `next` tag.

### Minor Changes

- e8ebcda: One history (ADR-017 §5): Studio's timeline is read from the actor journal.

  - The `timeline` table and its writes are gone; migration `0015_drop_timeline` drops it. A timeline entry is a journal event (`id` = `seq`), its after-state taken from a checkpoint or replayed from the newest checkpoint before it, checksum-verified. An after-state that cannot be rebuilt (another code version, a pruned journal without a checkpoint before it, a diverging replay) is `null`; the UI says "State not available" and shows no diff, and the CLI shape reports no changed paths for it.
  - `studio.timelineSize` is removed: journal retention (`journal: { keep }`) is the only retention. With `journal: false` the timeline is empty.
  - Redaction is applied to the rebuilt entries through `runtime/studio-project.ts`, as before. Cursor pagination, live `studio.timeline` pushes and "restore to here" work as before.

- 3fa386d: Studio production access (ADR-014). `/__studio` is authenticated with Cloudflare Access (SSO for people, one service token per agent); the `X-Actor-Kit-Studio-Key` header and `ACTOR_KIT_STUDIO_SECRET` are removed. Agents are read-only and see hashed callers (`STUDIO_CALLER_HASH_KEY`). Actors declare `studio: { redact: [...] }` path globs, applied in the Durable Object to everything Studio returns. Every Studio request emits a `studio.request` audit event. New `GET /__studio/api/actors/:type/:id/view` route, and the new `@actor-kit/studio-cli` package (`actor-kit studio list|types|inspect|timeline|view` and the `actor-kit-studio-mcp` server).
