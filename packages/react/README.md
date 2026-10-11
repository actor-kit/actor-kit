# @actor-kit/react

> **Docs for agents and humans:** this package ships its documentation in [`docs/`](docs/README.md) (matching the installed version). The whole site is at https://actorkit.dev, with https://actorkit.dev/llms.txt (an index) and https://actorkit.dev/llms-full.txt (everything in one file) for agents. Every error and refusal carries a `code` documented at https://actorkit.dev/errors/.


React hooks for Actor Kit -- typed `useView()`, `useSend()`, `useSelector()`, and `useRole()`.

## Install

```bash
pnpm add @actor-kit/core @actor-kit/client @actor-kit/react
```

## Usage

```tsx
import { actorClient } from "@actor-kit/client";
import { actorContext } from "@actor-kit/react";
import { counterContract } from "./contract";

const CounterActor = actorContext(counterContract);
// Create the client once (e.g. in a useEffect, and disconnect on unmount); see the docs.
const client = actorClient(counterContract).create({ path: "/api/counter/counter-1", initialView: { count: 0 } });

function App() {
  return (
    <CounterActor.Provider client={client}>
      <Counter />
    </CounterActor.Provider>
  );
}

function Counter() {
  const view = CounterActor.useView();
  const send = CounterActor.useSend();

  return <button onClick={() => send({ type: "INCREMENT" })}>Count: {view.count}</button>;
}
```

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
