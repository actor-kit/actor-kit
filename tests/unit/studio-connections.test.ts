import { toStudioConnections } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

type State = { ownerId: string };
const roles = {
  owner: (state: State, caller: string) => caller === state.ownerId,
  viewer: () => true,
};

describe("toStudioConnections", () => {
  it("maps SQLite rows to connections with the caller's current role", () => {
    const rows = [
      { caller: "alice", caller_type: "user", connected_at: 1000 },
      { caller: "bob", caller_type: "service", connected_at: 2000 },
    ];

    expect(toStudioConnections(rows, roles, { ownerId: "alice" })).toEqual([
      { caller: "alice", callerType: "user", connectedAt: 1000, role: "owner" },
      { caller: "bob", callerType: "service", connectedAt: 2000, role: "viewer" },
    ]);
  });

  it("returns role null when no role predicate matches", () => {
    const ownerOnly = { owner: (state: State, caller: string) => caller === state.ownerId };
    const rows = [{ caller: "mallory", caller_type: "user", connected_at: 5 }];

    expect(toStudioConnections(rows, ownerOnly, { ownerId: "alice" })).toEqual([
      { caller: "mallory", callerType: "user", connectedAt: 5, role: null },
    ]);
  });

  it("rejects rows with an unknown caller_type instead of coercing", () => {
    const rows = [{ caller: "eve", caller_type: "admin", connected_at: 1 }];
    expect(() => toStudioConnections(rows, roles, { ownerId: "alice" })).toThrow();
  });

  it("rejects rows with a non-numeric connected_at", () => {
    const rows = [{ caller: "eve", caller_type: "user", connected_at: "yesterday" }];
    expect(() => toStudioConnections(rows, roles, { ownerId: "alice" })).toThrow();
  });

  it("returns an empty list for no rows", () => {
    expect(toStudioConnections([], roles, { ownerId: "alice" })).toEqual([]);
  });
});
