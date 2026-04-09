# ADR 012: ctx.exports — Single-Worker Actor Discovery

**Date**: 2026-04-02
**Status**: Proposed
**Depends on**: ADR-011 (links)

## Context

Actor-to-actor communication currently relies on naming conventions to find DO bindings in `env`:

```typescript
// Convention: defineActor("profile") → binding name "PROFILE"
const stub = env.PROFILE.get(env.PROFILE.idFromName(profileId));
```

This has three problems:

1. **Fragile convention** — `contract.name.toUpperCase()` must match the wrangler.jsonc binding name. Nothing enforces this at compile time. A typo means a runtime error.

2. **Boilerplate** — every actor-to-actor relationship requires a manual entry in wrangler.jsonc's `durable_objects.bindings` array. For N actor types, that's N entries you maintain by hand.

3. **Auth ceremony** — `withCallerIdentity(request, { callerId, callerType })` stamps headers that the target trusts. But headers can be spoofed if someone calls the DO directly. The "trust" is by convention, not enforced by the platform.

Cloudflare's `ctx.exports` (behind `enable_ctx_exports` compatibility flag) solves all three. It provides auto-configured loopback bindings for all top-level exports — no wrangler.jsonc config, no naming conventions, platform-guaranteed identity via `ctx.props`.

## Decision

All actors in an Actor Kit project deploy as a single Worker. Actor-to-actor discovery uses `ctx.exports` instead of `env` bindings.

### Single-Worker deployment

All actor DO classes are exported from one Worker entry point:

```typescript
// worker.ts
import { createActorClass } from "@actor-kit/worker";
import { PlayerContract } from "./player.contract";
import { ProfileContract } from "./profile.contract";
import { GameContract } from "./game.contract";

export const PlayerActor = createActorClass(PlayerContract);
export const ProfileActor = createActorClass(ProfileContract);
export const GameActor = createActorClass(GameContract);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Route to actors...
  },
};
```

wrangler.jsonc still declares the DO classes (required for storage migrations), but bindings between actors are automatic via `ctx.exports`.

### Actor discovery via `ctx.exports`

Inside a DO, `this.ctx.exports` provides typed namespace bindings for all sibling DOs in the same Worker:

```typescript
// Inside PlayerActor — no env lookup, no naming convention
const profileNs = this.ctx.exports.ProfileActor;
const stub = profileNs.get(profileNs.idFromName(profileId));
const { snapshot } = await stub.getSnapshot("system", "service");
```

The framework uses `ctx.exports` internally for:
- **`link()`** — resolving target actor namespaces for subscriptions
- **Services** — when a service fn needs to call another actor
- **`createRef()`** — contract-based refs resolve via exports, not env

### Inter-actor identity via `ctx.props`

`ctx.props` is tamper-proof — only the deployer (or same-Worker code) can set it. When Actor A calls Actor B, the framework passes identity via props:

```typescript
// Framework internals — when PlayerActor links to ProfileActor:
const binding = this.ctx.exports.ProfileActor({
  props: {
    callerActor: "player",
    callerId: this.ctx.id.toString(),
    callerType: "service",
  },
});
const stub = binding.get(binding.idFromName(profileId));
```

The target actor reads `this.ctx.props` to authenticate the caller. No JWT. No header spoofing. Platform-guaranteed.

This replaces `withCallerIdentity()` for DO-to-DO calls. `withCallerIdentity()` remains for Worker `fetch()` handler → DO calls (where `ctx.exports` isn't available).

### Compatibility flag

Requires `enable_ctx_exports` in wrangler.jsonc:

```jsonc
{
  "compatibility_flags": ["enable_ctx_exports"]
}
```

This is a Cloudflare compatibility flag, not an Actor Kit flag. It's stable and documented.

### How link() uses ctx.exports

When a link is declared:

```typescript
links: {
  profile: link(ProfileContract, { onUpdate: ... }),
}
```

The framework needs to find the ProfileActor's DO namespace. With `ctx.exports`:

1. `ProfileContract.name` = `"profile"`
2. Framework looks for an export whose contract name matches: `ctx.exports.ProfileActor`
3. No naming convention needed — the framework iterates `ctx.exports` to find the DO class that was created from `ProfileContract`

To make this work, `createActorClass()` stamps the contract name on the DO class:

```typescript
export function createActorClass(contract) {
  const DOClass = actor(contract.name, contract.def);
  DOClass.__actorKitContractName = contract.name;  // discovery marker
  return DOClass;
}
```

Then the framework resolves:
```typescript
function resolveNamespace(contractName: string, exports: Record<string, unknown>) {
  for (const [key, value] of Object.entries(exports)) {
    if (value?.__actorKitContractName === contractName) {
      return exports[key];  // the DO namespace
    }
  }
  throw new Error(`No exported actor found for contract "${contractName}"`);
}
```

### How services access other actors

Service `fn` receives a context object with exports:

```typescript
services: {
  notifyProfile: {
    fn: async ({ profileId, data }, env, { actors }) => {
      // actors is a typed helper derived from ctx.exports
      const stub = actors.profile.get(profileId);
      return stub.send("system", "service", { type: "NOTIFY", ...data });
    },
  },
},
```

`actors` is a convenience wrapper around `ctx.exports` that provides `get(id)` shortcuts for each known actor type. The types are derived from the contracts declared in `links` and `services`.

### Fallback for multi-Worker

For the rare case where actors span multiple Workers, `env` bindings still work. The framework checks `ctx.exports` first, falls back to `env[BINDING_NAME]`:

```typescript
function resolveNamespace(contractName: string, exports: Record<string, unknown>, env: Record<string, unknown>) {
  // Try ctx.exports first (same Worker)
  for (const [key, value] of Object.entries(exports)) {
    if (value?.__actorKitContractName === contractName) {
      return exports[key];
    }
  }
  // Fall back to env binding (cross-Worker)
  const bindingName = contractName.toUpperCase().replace(/-/g, "_");
  if (env[bindingName]) return env[bindingName];
  throw new Error(`Actor "${contractName}" not found in ctx.exports or env`);
}
```

## Consequences

### Positive

- **Zero-config actor discovery** — no manual bindings for same-Worker actors
- **Compile-time safety** — `ctx.exports.ProfileActor` is typed. Typos are caught by TypeScript.
- **Platform-guaranteed auth** — `ctx.props` is tamper-proof. No JWT overhead for DO-to-DO.
- **Simpler onboarding** — one Worker, one wrangler.jsonc, all actors discovered automatically.
- **link() just works** — no naming conventions, no env plumbing.

### Negative

- **All actors deploy together** — can't independently version/deploy actor types. Fine for single-team products.
- **Requires compat flag** — `enable_ctx_exports` must be set. New projects get it by default; existing projects need to add it.
- **Bundle size** — all actor code in one Worker bundle (10MB limit). Not a concern for typical projects.
- **Discovery marker** — `__actorKitContractName` on DO classes is a runtime convention. Could be replaced by a WeakMap or Symbol if needed.

### Neutral

- `withCallerIdentity()` remains for Worker fetch → DO calls (non-DO callers don't have `ctx.exports`).
- wrangler.jsonc still needs DO class declarations (for storage migrations). Only the `bindings` array becomes optional for same-Worker actors.
- Multi-Worker deployment is supported via env binding fallback but is not the recommended path.
