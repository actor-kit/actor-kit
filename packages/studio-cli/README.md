# @actor-kit/studio-cli

> **Docs for agents and humans:** this package ships its documentation in [`docs/`](docs/README.md) (matching the installed version). The whole site is at https://actorkit.dev, with https://actorkit.dev/llms.txt (an index) and https://actorkit.dev/llms-full.txt (everything in one file) for agents. Every error and refusal carries a `code` documented at https://actorkit.dev/errors/.


Read-only access to [Actor Kit Studio](https://actorkit.dev/studio/overview/) from a terminal or an agent: a CLI and an MCP server. Values are redacted by the actor before they leave it, and agents see hashed callers.

## Install

```bash
pnpm add -D @actor-kit/studio-cli
```

## CLI

```bash
actor-kit studio list --type quiz
actor-kit studio inspect quiz room-42
actor-kit studio timeline quiz room-42 --limit 20 --shape
actor-kit studio view quiz room-42 --role player --caller alice
```

| Command | What it returns |
|---|---|
| `list` | Actors (`--type`, `--search`, `--limit`, `--offset`) |
| `types` | Actor types |
| `inspect <type> <id>` | State, connections, outbox and links |
| `timeline <type> <id>` | Journal entries, newest first (`--limit`, `--before`); `--shape` returns cause types, payload keys, changed paths and checksums only |
| `view <type> <id> --role <r>` | What a role sees (`--caller` for per-caller views) |

The Worker origin comes from `--url` or `ACTOR_KIT_STUDIO_URL`.

## Auth

| Environment | Use |
|---|---|
| `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` | An Access service token (agents) |
| `CF_ACCESS_TOKEN` | A person's token: `cloudflared access token -app=<url>` |
| none | Local `wrangler dev` |

## MCP

`actor-kit-studio-mcp` serves the same read-only tools over stdio. `timeline` defaults to `--shape`, so an agent sees what changed without seeing values.

## License

MIT
