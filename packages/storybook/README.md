# @actor-kit/storybook

Storybook integration for Actor Kit actors.

## Install

```bash
pnpm add -D @actor-kit/storybook
```

## Usage

```tsx
import { actorDecorator } from "@actor-kit/storybook";
import { counterContract } from "./contract";

export default {
  title: "Counter",
  decorators: [
    actorDecorator(counterContract, {
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
