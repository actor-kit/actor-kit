---
"@actor-kit/test": minor
---

`simulate()` pushes link views like the runtime: after every committed transition a source sends each linked actor its view (only when it changed), and the subscriber runs `link.onUpdate`. New links, including init links, get the current view at once.
