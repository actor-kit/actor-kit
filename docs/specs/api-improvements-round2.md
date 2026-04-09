# API Improvements — Round 2

Based on design review discussions. These are targeted improvements to ship before v0.1.0.

## 1. Role Discriminant on View Payloads

**Problem:** Views arrive without a `role` field. Clients can't use TypeScript discriminated unions to narrow role-specific fields. The `LinkedView<T>` type exists but nothing in the runtime produces it.

**Change:** `broadcastViews()` injects `{ role, ...viewData }` into every view push:
- WebSocket JSON frames: `{ role: "admin", count: 5, revenue: 100 }`
- WebSocket binary frames: role as a string prefix before the schema-encoded payload
- DO-to-DO link pushes: already include role (implemented in links)

**Files to change:**
- `packages/worker/src/actor.ts` — `broadcastViews()` adds role to JSON payload, role prefix to binary frame
- `packages/core/src/frame.ts` — `createSnapshotFrame()` and `createDeltaFrame()` accept role parameter
- `packages/client/src/client.ts` — `handleJsonMessage()` and binary decode path preserve role field
- `packages/client/src/builder.ts` — `ContractView<T>` becomes `LinkedView<T>` (discriminated union with role)

**Impact:** Every connected client and linked actor receives typed discriminated union views. `useView()`, `useSelector("admin", fn)`, and `view.role` narrowing all work end-to-end.

## 2. Client View Type = LinkedView

**Problem:** `actorClient<typeof Contract>()` currently types the view as a plain union of all view schemas (`AdminView | BidderView`). Without the `role` discriminant, TypeScript can't narrow.

**Change:** The view type becomes `LinkedView<TContract>`:
```typescript
// Before: { count: number; revenue: number } | { count: number }
// After:  { role: "admin"; count: number; revenue: number } | { role: "bidder"; count: number }
```

**Files to change:**
- `packages/client/src/builder.ts` — `ContractView<T>` → use `LinkedView<T>` from core
- `packages/react/src/context.ts` — `useView()` return type includes role discriminant
- All doc examples showing `subscribe((view) => ...)` should show role narrowing

## 3. Role Composition Helper

**Problem:** If admin should see everything a user can, you must manually ensure the admin view is a superset. No way to express "admin inherits user."

**Change:** Add a `withRoles()` helper for composing role predicates:

```typescript
import { withRoles } from "@actor-kit/worker";

roles: {
  admin: (_state, _caller, { callerType }) => callerType === "service",
  moderator: (state, caller) => state.moderators.includes(caller),
  user: () => true,
},

// Admin view includes everything from user view plus admin-only fields
views: {
  admin: view(AdminView, (state) => ({
    ...userProjection(state),  // reuse the user projection
    revenue: state.revenue,
    settings: state.settings,
  })),
  moderator: view(ModView, (state) => ({
    ...userProjection(state),
    reports: state.reports,
  })),
  user: view(UserView, userProjection),
},
```

This is just a pattern recommendation (extract shared projection functions), not a framework feature. Document it.

For message guards, "admin can do everything user can" already works because messages are flat — all roles can send all messages by default. Guards only restrict.

## 4. Remove `emit()` Remnants from MessageContext

**Problem:** `emit` was removed from types but some internal code or docs may still reference `EmitFn` or the old `Effect` type.

**Change:** Audit and remove any remaining `emit`/`Effect`/`EmitFn` references across all packages. Clean sweep.

## 5. Simplify Init Context

**Problem:** `init(input, env, { link })` — the third arg is an object with just `link`. If we add more init-time capabilities later, the context grows.

**Change:** Standardize as `init(input, ctx)` where ctx includes `{ env, link }`:

```typescript
init: async (input, ctx) => {
  const profile = await ctx.link("profile", input.profileId);
  const config = await ctx.env.KV.get("config");
  return { profile, config };
},
```

This is a breaking change to the init signature. `env` moves from second arg to `ctx.env`. Cleaner, more extensible.

**Trade-off:** Every existing init function breaks. But we said no backwards compat needed.

## 6. Relay Actor Pattern (Documentation Only)

**Problem:** Single DO can't handle 100K connections. The relay pattern using links is the solution but not documented.

**Change:** Add a recipe: `/recipes/scaling-with-relays/` showing:
- Source actor holds state
- Relay actors link to source, pass through views
- Worker routes clients to relay DOs based on load
- Source pushes to ~100 relays, each relay handles ~1000 clients

No framework changes — just documentation of the pattern using existing `link()`.

## 7. Guard Access to `link`/`unlink`

**Problem:** `GuardContext` now has `link` and `unlink` (added with MessageContext). Guards should be pure predicates — they shouldn't have side effects.

**Change:** Remove `link`/`unlink` from `GuardContext`. Guards only get `{ role, caller, callerType, env, execute }`. Actually, guards shouldn't have `execute` either — they're predicates, not effect handlers.

Simplify `GuardContext` to:
```typescript
interface GuardContext<TEnv = unknown> {
  readonly role: string;
  readonly caller: string;
  readonly callerType: "user" | "service";
  readonly env: TEnv;
}
```

No `execute`, no `link`, no `unlink`. Pure predicate context.

## 8. Wire `await link()` in Init (Codex P1)

**Problem:** Docs show `await link("profile", input.profileId)` in init, but:
- `init(input, env)` has no third arg — `{ link }` isn't passed
- `ctx.link()` on MessageContext is `void`, not `Promise<View>`
- The init-time blocking link pattern is designed but not implemented

**Change:** Update `actor()` to pass a link context to init:
```typescript
// In actor.ts spawn():
const linkCtx = {
  link: async (name: string, id: string): Promise<unknown> => {
    // Resolve namespace, getSnapshot(), register subscription, return view
  },
};
this.state = await def.init(parsed.data, this.env, linkCtx);
```

Also add an async `link()` overload on MessageContext that returns `Promise<View>` for init usage.

## 9. Export `createRef` from Main Entry (Codex P1)

**Problem:** `createRef` is only exported from `@actor-kit/worker/testing`, not `@actor-kit/worker`. Docs show importing it from the main entry.

**Change:** Export `createRef` and `ActorRef` from `packages/worker/src/index.ts`.

## 10. Fix Test Harness Async Docs (Codex P2)

**Problem:** Doc examples show `const next = t.send(...)` without `await`. Both `send()` and `sendWithEffects()` return Promises.

**Change:** Add `await` to all test examples in docs.

## 11. Fix FAQ Stale Content (Codex P2)

**Problem:**
- FAQ points to queue-bounce workaround instead of `onDone`/`onError` for service results
- FAQ promises retry/backoff/failure table that don't exist in the runtime
- Timer docs reference `ctx.storage.setAlarm()` which isn't on MessageContext

**Change:** Rewrite affected FAQ entries to match current API.

## 12. Fix WebSocket Error Detail (Codex P3)

**Problem:** Docs promise a `detail` field on WebSocket validation errors, but `webSocketMessage()` only sends `{ type: "__error", message, error }`.

**Change:** Either add `detail` to the error payload in actor.ts, or update docs to match current behavior.

## Priority Order (Updated)

1. **Role discriminant on views** (#1 + #2) — enables the core type narrowing story end-to-end
2. **Wire `await link()` in init** (#8) — makes the designed link API actually work
3. **Init context cleanup** (#5) — `init(input, ctx)` with `{ env, link }`
4. **Guard context cleanup** (#7) — remove execute/link/unlink from guards
5. **Export createRef** (#9) — quick fix
6. **Fix test async docs** (#10) — quick doc fix
7. **Fix FAQ stale content** (#11) — doc rewrite
8. **emit remnant cleanup** (#4) — quick sweep
9. **Fix error detail** (#12) — small runtime or doc fix
10. **Role composition docs** (#3) — documentation
11. **Relay pattern docs** (#6) — documentation
