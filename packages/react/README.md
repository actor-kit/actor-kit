# @actor-kit/react

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
    <CounterActor.Provider url="wss://my-worker.example.com" actorId="counter-1" token={token}>
      <Counter />
    </CounterActor.Provider>
  );
}

function Counter() {
  const count = useSelector(CounterActor, (view) => view.count);
  const send = useSend(CounterActor);

  return <button onClick={() => send("increment", {})}>Count: {count}</button>;
}
```

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
