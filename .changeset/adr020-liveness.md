---
"@actor-kit/client": minor
"@actor-kit/worker": minor
"@actor-kit/core": patch
"@actor-kit/react": patch
---

ADR-020: the client pings the actor (`heartbeat`, on by default: every 20 s and on visible/online; a socket silent 5 s after a ping is replaced), queues sends made while the socket closes, and asks for the view again after a frame that does not decode (reported through `onError` if it still does not). The actor answers pings without waking. Core rejects frames and payloads that end early or have bytes left over. React's `useSelector`, `useRole` and `useConnectionState` never render a stale value; `useView` follows a new client on its first render.
