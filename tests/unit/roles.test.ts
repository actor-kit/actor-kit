import { type RolePredicate, resolveRole } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

type State = {
  ownerId: string;
  memberIds: string[];
  gmIds: string[];
};

describe("resolveRole()", () => {
  const roles = {
    service: ((_state: State, _caller: string, claims: { callerType: "user" | "service" }) =>
      claims.callerType === "service") satisfies RolePredicate<State>,
    owner: ((state: State, caller: string) => caller === state.ownerId) satisfies RolePredicate<State>,
    member: ((state: State, caller: string) => state.memberIds.includes(caller)) satisfies RolePredicate<State>,
    viewer: (() => true) satisfies RolePredicate<State>,
  };

  const state: State = {
    ownerId: "alice",
    memberIds: ["bob", "carol"],
    gmIds: ["gm-admin"],
  };

  it("returns the first matching role (top-to-bottom)", () => {
    const role = resolveRole(roles, state, "alice", { callerType: "user" });
    expect(role).toBe("owner");
  });

  it("returns member for a member caller", () => {
    const role = resolveRole(roles, state, "bob", { callerType: "user" });
    expect(role).toBe("member");
  });

  it("returns viewer for unknown caller (catch-all)", () => {
    const role = resolveRole(roles, state, "stranger", { callerType: "user" });
    expect(role).toBe("viewer");
  });

  it("returns service for service callerType", () => {
    const role = resolveRole(roles, state, "matchmaker", { callerType: "service" });
    expect(role).toBe("service");
  });

  it("first match wins — owner who is also a member gets owner", () => {
    const stateWithOwnerAsMember: State = {
      ownerId: "alice",
      memberIds: ["alice", "bob"],
      gmIds: [],
    };
    const role = resolveRole(roles, stateWithOwnerAsMember, "alice", { callerType: "user" });
    expect(role).toBe("owner");
  });

  it("returns null when no role matches", () => {
    const strictRoles = {
      owner: ((state: State, caller: string) => caller === state.ownerId) satisfies RolePredicate<State>,
      // No catch-all
    };
    const role = resolveRole(strictRoles, state, "stranger", { callerType: "user" });
    expect(role).toBeNull();
  });

  it("preserves definition order via object key iteration", () => {
    // This test ensures we rely on insertion order
    const orderedRoles = {
      first: (() => true) satisfies RolePredicate<State>,
      second: (() => true) satisfies RolePredicate<State>,
    };
    const role = resolveRole(orderedRoles, state, "anyone", { callerType: "user" });
    expect(role).toBe("first");
  });

  it("role predicate receives callerType from claims", () => {
    let receivedCallerType: string | undefined;
    const testRoles = {
      test: ((_state: State, _caller: string, claims: { callerType: "user" | "service" }) => {
        receivedCallerType = claims.callerType;
        return true;
      }) satisfies RolePredicate<State>,
    };
    resolveRole(testRoles, state, "anyone", { callerType: "service" });
    expect(receivedCallerType).toBe("service");
  });
});
