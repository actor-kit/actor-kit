---
"@actor-kit/core": patch
"@actor-kit/worker": patch
"@actor-kit/client": patch
"@actor-kit/react": patch
"@actor-kit/test": patch
"@actor-kit/storybook": patch
"@actor-kit/studio": patch
"@actor-kit/studio-cli": patch
---

ADR-018 H: docs ship with the code. Every package publishes a `docs/` folder with the pages its users need (generated from the website, links absolute), READMEs point there and to https://actorkit.dev/llms.txt and llms-full.txt, and every error code has a page under https://actorkit.dev/errors/, so each error's `docs` URL resolves.
