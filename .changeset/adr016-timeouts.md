---
"@actor-kit/worker": minor
---

Timeouts and cancellation for services and forwards (ADR-016 §3).

- `timeoutMs` per service and per link (`link(Contract, { timeoutMs })`), **default 30 000**. On expiry the try's `effect.signal` is aborted and the try fails as `{ _tag: "Timeout", ms }`, retried by default. A long job must set a larger `timeoutMs`.
- Restore aborts tries in flight of the effects it cancels; redrive aborts a try of the redriven effect still in flight. A result that arrives after its try was aborted is discarded, never applied. `runAttempt`, `createInFlight`, `resolveTimeoutMs` and `DEFAULT_TIMEOUT_MS` are exported from `@actor-kit/worker/testing`.
- The Workers runtime has no shutdown hook for a Durable Object: tries in flight when an isolate is evicted die with it and run again on wake.
