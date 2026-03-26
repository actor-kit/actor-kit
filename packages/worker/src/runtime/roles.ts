/**
 * Role evaluation — resolves a caller's role from state-derived predicates.
 *
 * Roles are evaluated top-to-bottom (object insertion order).
 * First match wins. Returns null if no role matches.
 */

export type RolePredicate<TState> = (
  state: TState,
  caller: string,
  claims: { callerType: "user" | "service" },
) => boolean;

export function resolveRole<TState, TRoles extends Record<string, RolePredicate<TState>>>(
  roles: TRoles,
  state: TState,
  caller: string,
  claims: { callerType: "user" | "service" },
): (keyof TRoles & string) | null {
  for (const roleName of Object.keys(roles)) {
    const predicate = roles[roleName];
    if (predicate?.(state, caller, claims)) {
      return roleName;
    }
  }
  return null;
}
