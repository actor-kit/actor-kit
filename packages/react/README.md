# @actor-kit/react

> **Docs for agents and humans:** this package ships its documentation in [`docs/`](docs/README.md) (matching the installed version). The whole site is at https://actorkit.dev, with https://actorkit.dev/llms.txt (an index) and https://actorkit.dev/llms-full.txt (everything in one file) for agents. Every error and refusal carries a `code` documented at https://actorkit.dev/errors/.


React hooks for Actor Kit -- typed `useView()`, `useSend()`, `useSelector()`, and `useRole()`.

## Install

```bash
pnpm add @actor-kit/core @actor-kit/client @actor-kit/react
```

## Usage

```tsx
import { actorContext } from "@actor-kit/react";
import { counterContract } from "./contract";

const CounterActor = actorContext(counterContract);

function App() {
  return (
    <CounterActor.Provider url="wss://my-worker.example.com" actorId="counter-1">
      <Counter />
    </CounterActor.Provider>
  );
}

function Counter() {
  const view = CounterActor.useView();
  const send = CounterActor.useSend();

  return <button onClick={() => send("increment", {})}>Count: {view.count}</button>;
}
```

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
