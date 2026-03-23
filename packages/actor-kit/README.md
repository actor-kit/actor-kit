# actor-kit

Actors on the edge. Real-time state sync with Cloudflare Durable Objects.

## Install

```bash
pnpm add actor-kit
```

## Quick Start

```typescript
import { actor, schema, view, message } from "actor-kit";
import { z } from "zod";

const CounterView = schema({ count: uint32 });

const increment = message(
  z.object({ amount: z.number().positive() }),
  (state, { amount }) => ({ ...state, count: state.count + amount }),
);

export const Counter = actor("counter", {
  input: z.object({}),
  init: () => ({ count: 0 }),
  roles: {
    user: () => true,
  },
  messages: {
    user: { INCREMENT: increment },
  },
  views: {
    user: view(CounterView, (state) => ({ count: state.count })),
  },
});
```

## Subpath Exports

| Import | What | Runtime |
|--------|------|---------|
| `actor-kit` | `actor()`, `schema()`, `view()`, `message()`, `ref()`, encode/decode, auth | Server (CF Workers) |
| `actor-kit/client` | `createActorClient()`, binary decoder, frame parser | Browser |
| `actor-kit/react` | `createActorContext()`, `useView()`, `useSend()`, `useRole()` | Browser (React) |
| `actor-kit/test` | `testActor()` | Test runner |

## Features

- **Role-based access** — roles derived from state, per-role messages and views
- **Binary sync** — schema-defined views with bitmask delta encoding
- **Guards** — conditional message handling without if-statements
- **Transactional outbox** — `emit()` for fire-and-forget, `request()` for async with callbacks
- **DO Alarms** — `after` timers that survive hibernation, `tick` for game loops
- **Actor-to-actor RPC** — `ref()` for DO-to-DO communication
- **States** — optional sequential or parallel finite states
- **WebSocket hibernation** — caller metadata survives DO restarts via tags

## License

MIT
