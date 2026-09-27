---
"@actor-kit/core": patch
"@actor-kit/client": patch
"@actor-kit/worker": patch
"@actor-kit/test": patch
"@actor-kit/studio": patch
"@actor-kit/storybook": patch
---

- Zod 4: `message()` infers the payload from the schema's output; empty payloads (`z.object({})`) type as `{ type: K }`. New shared `ContractMessages` / `MessageEvent` types in `@actor-kit/core`.
- Client: `client.role` is seeded from `initialView.role`, so role-branching UIs render the correct branch during SSR.
- Studio: live updates survive Durable Object hibernation; connections show role and connected time; manual connect is always available.
- Storybook: peer range now includes `@storybook/react` 10.
