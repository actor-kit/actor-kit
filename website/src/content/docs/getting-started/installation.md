---
title: Installation
description: Install Actor Kit packages and configure your Cloudflare Worker project.
---

## Install packages

Install the core packages plus peer dependencies:

```bash
pnpm add @actor-kit/types @actor-kit/worker @actor-kit/browser @actor-kit/react @actor-kit/server xstate zod react
```

> `react` is only required if using `@actor-kit/react`. The core packages (`@actor-kit/worker`, `@actor-kit/browser`, `@actor-kit/server`) work without React.

For testing and Storybook:

```bash
pnpm add -D @actor-kit/test @actor-kit/storybook
```

## Set up your Cloudflare Worker

You'll need [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed:

```bash
pnpm add -D wrangler
```

### Configure secrets

For development, create a `.dev.vars` file in your project root:

```bash
ACTOR_KIT_SECRET=your-secret-key-here
```

Replace `your-secret-key-here` with a secure, randomly generated secret. This is used to sign JWT access tokens.

For production, set the secret using Wrangler:

```bash
npx wrangler secret put ACTOR_KIT_SECRET
```

### Configure wrangler.toml

Create a `wrangler.toml` with your Durable Object bindings:

```toml
name = "your-project-name"
main = "src/server.ts"
compatibility_date = "2024-09-25"

[[durable_objects.bindings]]
name = "TODO"
class_name = "Todo"

[[migrations]]
tag = "v1"
new_classes = ["Todo"]
```

The binding `name` must be the SCREAMING_SNAKE_CASE version of your actor type. For example, actor type `"todo"` maps to binding `TODO`, and `"game-session"` maps to `GAME_SESSION`.

## Next step

With packages installed and Wrangler configured, you're ready to build your first actor:

→ [Quick Start](/getting-started/quick-start/)
