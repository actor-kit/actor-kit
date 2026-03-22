# ADR 001: Offensive Type Safety

**Date**: 2026-03-22
**Status**: Accepted

## Context

Actor Kit v2's `actor()` function infers types across multiple layers: state from `init()`, roles from `roles` keys, message types per role, view schemas per role, and a discriminated union of all views. If any layer uses `any` or `as` casts, the inference chain breaks and the user loses type safety in their client code.

## Decision

TypeScript's type system is a development accelerator, not a tax. We treat it offensively:

### Rules

1. **No `any`** — use `unknown` and narrow with type guards or Zod parsing.
2. **No `as` casts** — if the compiler can't verify it, restructure until it can. The only acceptable escape hatch is `as const` for literal inference.
3. **No non-null assertions (`!`)** — check for null/undefined explicitly.
4. **No `@ts-ignore` or `@ts-expect-error`** — fix the type error.
5. **Strict mode always** — `strict: true` in tsconfig, including `strictNullChecks`, `strictFunctionTypes`, `noUncheckedIndexedAccess`.
6. **Generic inference over manual annotation** — the `actor()` function should infer all types from the definition. Users should never write `actor<MyState, MyRoles, ...>()`.
7. **Zod at boundaries** — all external data (events, input, WebSocket frames) parsed through Zod. Internal data trusted after parsing.
8. **No index signatures without `noUncheckedIndexedAccess`** — `Record<string, T>` returns `T | undefined`.

### How to apply

When implementing a feature:
- Prototype the types first (`.d.ts` that compiles). Verify inference works before writing runtime code.
- If a generic constraint won't infer, simplify the API surface rather than adding `as`.
- If a library's types are insufficient (e.g., XState's strict generics), use `const` assertions or wrapper types — never `as unknown as`.

## Consequences

- Some patterns that would be easy with `any` require more thoughtful type design.
- The `actor()` function's generic signature will be complex, but users never see it — they just write plain objects and get full inference.
- Third-party library integration may require wrapper types instead of direct casting.
- Every surviving type error is a real bug caught at compile time.
