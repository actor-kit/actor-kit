---
"@actor-kit/react": patch
---

`useClient(options)` connects in a layout effect, so a child that sends on mount (in `useEffect`) sends on a connecting client, which queues the message, instead of on one not yet connected, which dropped it. React runs a child's effects before its parent's.
