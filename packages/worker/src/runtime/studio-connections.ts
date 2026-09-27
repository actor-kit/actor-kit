/**
 * Studio connection rows — parses `studio_connections` SQLite rows at the
 * storage boundary and resolves each caller's current role.
 */

import { z } from "zod";
import { type RolePredicate, resolveRole } from "./roles";

const StudioConnectionRowSchema = z.object({
  caller: z.string(),
  caller_type: z.enum(["user", "service"]),
  connected_at: z.number(),
});

export interface StudioConnection {
  caller: string;
  callerType: "user" | "service";
  connectedAt: number;
  role: string | null;
}

export function toStudioConnections<TState>(
  rows: ReadonlyArray<unknown>,
  roles: Record<string, RolePredicate<TState>>,
  state: TState,
): StudioConnection[] {
  return rows.map((raw) => {
    const row = StudioConnectionRowSchema.parse(raw);
    return {
      caller: row.caller,
      callerType: row.caller_type,
      connectedAt: row.connected_at,
      role: resolveRole(roles, state, row.caller, { callerType: row.caller_type }),
    };
  });
}
