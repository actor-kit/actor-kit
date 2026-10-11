# @actor-kit/storybook

> **Docs for agents and humans:** this package ships its documentation in [`docs/`](docs/README.md) (matching the installed version). The whole site is at https://actorkit.dev, with https://actorkit.dev/llms.txt (an index) and https://actorkit.dev/llms-full.txt (everything in one file) for agents. Every error and refusal carries a `code` documented at https://actorkit.dev/errors/.


Storybook integration for Actor Kit actors.

## Install

```bash
pnpm add -D @actor-kit/storybook
```

## Usage

```tsx
import { withActorKit } from "@actor-kit/storybook";
import { counterContract } from "./contract";

export default {
  title: "Counter",
  decorators: [
    withActorKit(counterContract, {
      initialState: { count: 5 },
    }),
  ],
};

export const Default = () => <Counter />;
```

## Docs

Full documentation at [actorkit.dev](https://actorkit.dev).

## License

MIT
