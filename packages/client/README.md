# @actor-kit/client

> **Docs for agents and humans:** this package ships its documentation in [`docs/`](docs/README.md) (matching the installed version). The whole site is at https://actorkit.dev, with https://actorkit.dev/llms.txt (an index) and https://actorkit.dev/llms-full.txt (everything in one file) for agents. Every error and refusal carries a `code` documented at https://actorkit.dev/errors/.


Browser and React Native client for connecting to Actor Kit actors via WebSocket with typed views and events.

## Install

```bash
pnpm add @actor-kit/core @actor-kit/client
```

## Usage

```ts
import { actorClient } from "@actor-kit/client";
import type { counterContract } from "./contract"; // a type only: zod stays out of the bundle
import { counterRoles, counterViews } from "./counter.views"; // the zod-free roles and view schemas

const client = actorClient<typeof counterContract>({ roles: counterRoles, views: counterViews }).create({
  path: "/api/counter/counter-1", // through your Worker; host defaults to the page's
  initialView: { count: 0 },
});
client.connect();

// Subscribe to view updates
client.subscribe((view) => {
  console.log("Count:", view.count);
});

// Send typed messages
client.send({ type: "INCREMENT" });

// Disconnect when done
client.disconnect();
```

The client connects to the Worker, which authenticates the caller and stamps identity via `withCallerIdentity()`. No access token is required on the client side in the Worker-trust model.

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
