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
import { counterContract } from "./contract";

const client = actorClient(counterContract).create({
  url: "wss://my-worker.example.com",
  actorId: "counter-1",
});

// Subscribe to view updates
client.subscribe((view) => {
  console.log("Count:", view.count);
});

// Send typed messages
client.send("increment", {});

// Disconnect when done
client.disconnect();
```

The client connects to the Worker, which authenticates the caller and stamps identity via `withCallerIdentity()`. No access token is required on the client side in the Worker-trust model.

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
