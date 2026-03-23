/**
 * view() helper — pairs a schema with a projection function.
 *
 * Usage:
 *   const ownerView = view(OwnerViewSchema, (state: State, caller) => ({
 *     todos: state.todos,
 *     memberCount: state.memberIds.length,
 *   }));
 */

import type { FieldDescriptor, Infer, SchemaDefinition } from "../schema/schema";

export interface ViewDef<TState, TShape extends Record<string, FieldDescriptor>> {
  readonly schema: SchemaDefinition<TShape>;
  readonly fn: (state: TState, caller: string) => Infer<SchemaDefinition<TShape>>;
}

export function view<TState, TShape extends Record<string, FieldDescriptor>>(
  schemaArg: SchemaDefinition<TShape>,
  fn: (state: TState, caller: string) => Infer<SchemaDefinition<TShape>>,
): ViewDef<TState, TShape> {
  return { schema: schemaArg, fn };
}
