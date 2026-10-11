---
"@actor-kit/client": patch
---

Docs: the "Keep zod out of the client bundle" note says that client code's own `import { z } from "zod"` pulls in classic zod (~450 KB minified, locales included) and recommends `zod/mini` for client-side checks (~13 KB for the same check).
