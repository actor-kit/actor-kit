# @actor-kit/core

> **Docs for agents and humans:** this package ships its documentation in [`docs/`](docs/README.md) (matching the installed version). The whole site is at https://actorkit.dev, with https://actorkit.dev/llms.txt (an index) and https://actorkit.dev/llms-full.txt (everything in one file) for agents. Every error and refusal carries a `code` documented at https://actorkit.dev/errors/.


Schema primitives, view definitions, binary encoding, and shared types for Actor Kit.

## Install

```bash
pnpm add @actor-kit/core
```

## Usage

```ts
import { schema, view, uint32, string, boolean, array } from "@actor-kit/core";
import type { Infer } from "@actor-kit/core";

// Define a binary-encodable schema
const TodoSchema = schema({
  count: uint32,
  items: array(schema({ text: string, done: boolean })),
});

// Infer the TypeScript type
type Todo = Infer<typeof TodoSchema>;

// Pair a schema with a projection function
const todoView = view(TodoSchema, (state) => ({
  count: state.items.length,
  items: state.items.map((i) => ({ text: i.text, done: i.done })),
}));
```

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
