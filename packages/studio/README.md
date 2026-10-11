# @actor-kit/studio

> **Docs for agents and humans:** this package ships its documentation in [`docs/`](docs/README.md) (matching the installed version). The whole site is at https://actorkit.dev, with https://actorkit.dev/llms.txt (an index) and https://actorkit.dev/llms-full.txt (everything in one file) for agents. Every error and refusal carries a `code` documented at https://actorkit.dev/errors/.


Devtools for Actor Kit: a dashboard of every actor, and for each one its live state and phase, a timeline built from the journal (diffs, emitted events, causation links, restore), connections, outbox (with redrive), timers and links. Served by your Worker at `/__studio`.

## Install

```bash
pnpm add @actor-kit/studio
```

## Setup

```ts
import { actorKitStudio, StudioRegistry } from "@actor-kit/studio";

export { StudioRegistry };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const studio = actorKitStudio(request, env, ctx);
    if (studio) return studio;
    // ...your routes
  },
};
```

```toml
[[durable_objects.bindings]]
name = "STUDIO_REGISTRY"
class_name = "StudioRegistry"

[[migrations]]
tag = "v2"
new_sqlite_classes = ["StudioRegistry"]
```

Enable it per actor with `studio: { enabled: true }` in the actor definition (`kit.actor(name, { ..., studio })`), and redact values with path globs such as `studio: { enabled: true, redact: ["players.*.name", "**.email"] }`.

## Production

On `localhost` Studio is open. In production it requires Cloudflare Access: set `STUDIO_ACCESS_TEAM_DOMAIN` and `STUDIO_ACCESS_AUD`, plus the secrets `STUDIO_ADMIN_EMAILS` (who may restore or redrive) and `STUDIO_CALLER_HASH_KEY` (hashes callers for agents). Agents are always read-only. See the [Studio setup guide](https://actorkit.dev/studio/setup/).

## Agents

`@actor-kit/studio-cli` gives terminals and agents read-only access to the same data, including an MCP server.

## License

MIT
