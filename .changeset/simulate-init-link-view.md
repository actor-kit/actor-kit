---
"@actor-kit/test": patch
---

`simulate()` refuses an init link whose target view is not an object, as the runtime does (it used to pass just the role).
