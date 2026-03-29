# @actor-kit/client

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
