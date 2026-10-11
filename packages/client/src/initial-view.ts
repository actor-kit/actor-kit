/**
 * Boot-view validation for actorClient().create({ initialView }): the view a Worker inlined (often as
 * JSON) is checked against the view schema before the client uses it, and a mismatch is refused with
 * a coded error in the ADR-018 C shape (code, full-sentence message naming the fix, docs URL).
 */

import {
  ActorKitError,
  describeIssues as describe,
  type FieldDescriptor,
  type SchemaDefinition,
  type StandardIssue,
} from "@actor-kit/core";

type AnySchema = SchemaDefinition<Record<string, FieldDescriptor>>;

const FIX = "Pass the view the server rendered for this caller.";

/** A boot view that does not match its schema (ADR-018 C: code `invalid_initial_view`, a docs URL). */
export class InitialViewError extends ActorKitError {
  readonly issues: readonly StandardIssue[];
  constructor(message: string, issues: readonly StandardIssue[]) {
    super("invalid_initial_view", `${message} ${FIX}`, issues);
    this.name = "InitialViewError";
    this.issues = issues;
  }
}

function issuesOf(viewSchema: AnySchema, view: unknown): readonly StandardIssue[] {
  return viewSchema["~standard"].validate(view).issues ?? [];
}

/** A schema-built client: the view must match the schema. */
export function checkViewAgainst(viewSchema: AnySchema, view: unknown): void {
  const issues = issuesOf(viewSchema, view);
  if (issues.length > 0) {
    throw new InitialViewError(
      `actorClient().create: initialView does not match the view schema (${describe(issues)}).`,
      issues,
    );
  }
}

function roleOf(view: unknown): string | undefined {
  const role: unknown = typeof view === "object" && view !== null ? Reflect.get(view, "role") : undefined;
  return typeof role === "string" ? role : undefined;
}

/**
 * A contract client: the view names its role, whose schema it must match; without a role it must
 * match some role's schema, unless some role has no schema. A role without a schema is not checked.
 */
export function checkContractView(
  name: string,
  roleNames: readonly string[] | undefined,
  viewSchemas: Readonly<Record<string, AnySchema>>,
  view: unknown,
): void {
  const role = roleOf(view);
  const prefix = `actorClient(${name}).create: initialView`;
  if (role !== undefined) {
    const own = viewSchemas[role];
    const issues = own === undefined ? [] : issuesOf(own, view);
    if (issues.length > 0)
      throw new InitialViewError(`${prefix} does not match the "${role}" view (${describe(issues)}).`, issues);
    return;
  }
  // A role without a schema could be the view's own: nothing to check it against.
  if (roleNames?.some((r) => viewSchemas[r] === undefined)) return;
  const checked = Object.entries(viewSchemas).map(([roleName, s]) => ({ roleName, issues: issuesOf(s, view) }));
  const [first] = checked;
  if (first === undefined || checked.some((c) => c.issues.length === 0)) return;
  const roles = checked.map((c) => `"${c.roleName}"`).join(", ");
  throw new InitialViewError(
    `${prefix} matches none of the views (${roles}); against "${first.roleName}": ${describe(first.issues)}.`,
    first.issues,
  );
}
