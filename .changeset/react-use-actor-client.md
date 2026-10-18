---
"@actor-kit/react": minor
---

`Ctx.useActorClient()` returns the Provider's client, for code that works with it directly (subscribe to every change for an animation or a sound cue, read `client.view` in an effect). It is 0.52's `useClient()` without arguments; 0.3's `useClient(options)` creates a client.
