/**
 * View definitions — pair a schema with a projection function.
 *
 * Two variants:
 *   view.shared(schema, (state) => ({...}))       — no caller, cacheable across sockets
 *   view.perCaller(schema, (state, caller) => ({...}))  — per-caller projection
 */

import type { FieldDescriptor, Infer, SchemaDefinition } from "./schema";

export interface SharedViewDef<TState, TShape extends Record<string, FieldDescriptor>> {
  readonly kind: "shared";
  readonly schema: SchemaDefinition<TShape>;
  readonly fn: (state: TState) => Infer<SchemaDefinition<TShape>>;
}

export interface PerCallerViewDef<TState, TShape extends Record<string, FieldDescriptor>> {
  readonly kind: "perCaller";
  readonly schema: SchemaDefinition<TShape>;
  readonly fn: (state: TState, caller: string) => Infer<SchemaDefinition<TShape>>;
}

export type ViewDef<
  TState = unknown,
  TShape extends Record<string, FieldDescriptor> = Record<string, FieldDescriptor>,
> = SharedViewDef<TState, TShape> | PerCallerViewDef<TState, TShape>;

export const view = {
  shared<TState, TShape extends Record<string, FieldDescriptor>>(
    schemaArg: SchemaDefinition<TShape>,
    fn: (state: TState) => Infer<SchemaDefinition<TShape>>,
  ): SharedViewDef<TState, TShape> {
    return { kind: "shared", schema: schemaArg, fn };
  },

  perCaller<TState, TShape extends Record<string, FieldDescriptor>>(
    schemaArg: SchemaDefinition<TShape>,
    fn: (state: TState, caller: string) => Infer<SchemaDefinition<TShape>>,
  ): PerCallerViewDef<TState, TShape> {
    return { kind: "perCaller", schema: schemaArg, fn };
  },
};
