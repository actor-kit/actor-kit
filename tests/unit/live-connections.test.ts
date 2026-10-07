import {
  isStudioSocket,
  nextConnectionSeq,
  readConnectionAttachment,
  toLiveConnections,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

type State = { ownerId: string };
const roles = {
  owner: (state: State, caller: string) => caller === state.ownerId,
  viewer: () => true,
};
const state: State = { ownerId: "alice" };

function socket(caller: string, callerType: string, attachment: unknown) {
  return { tags: [`caller:${caller}`, `callerType:${callerType}`], attachment };
}

describe("toLiveConnections", () => {
  it("lists one connection per socket, same caller included, oldest first, with roles", () => {
    const sockets = [
      socket("bob", "service", { connectionId: "c3", connectedAt: 30 }),
      socket("alice", "user", { connectionId: "c1", connectedAt: 10 }),
      socket("alice", "user", { connectionId: "c2", connectedAt: 20 }),
    ];

    expect(toLiveConnections(sockets, roles, state)).toEqual([
      { connectionId: "c1", caller: "alice", callerType: "user", connectedAt: 10, role: "owner" },
      { connectionId: "c2", caller: "alice", callerType: "user", connectedAt: 20, role: "owner" },
      { connectionId: "c3", caller: "bob", callerType: "service", connectedAt: 30, role: "viewer" },
    ]);
  });

  it("orders connections that share a connectedAt millisecond by connect sequence, whatever order the sockets arrive in", () => {
    const sockets = [
      socket("ivan", "user", { connectionId: "second", connectedAt: 10, seq: 2 }),
      socket("hank", "user", { connectionId: "first", connectedAt: 10, seq: 1 }),
    ];
    expect(toLiveConnections(sockets, roles, state).map((c) => c.connectionId)).toEqual(["first", "second"]);
  });

  it("numbers the next connection after the highest live sequence", () => {
    const sockets = [
      socket("a", "user", { connectionId: "x", connectedAt: 1, seq: 4 }),
      socket("b", "user", { connectionId: "y", connectedAt: 1, seq: 7 }),
      { tags: ["caller:__studio", "callerType:service"], attachment: null },
    ];
    expect(nextConnectionSeq(sockets)).toBe(8);
    expect(nextConnectionSeq([])).toBe(1);
  });

  it("leaves out the Studio socket", () => {
    const sockets = [
      { tags: ["caller:__studio", "callerType:service"], attachment: null },
      socket("alice", "user", { connectionId: "c1", connectedAt: 1 }),
    ];
    expect(toLiveConnections(sockets, roles, state).map((c) => c.connectionId)).toEqual(["c1"]);
  });

  it("returns role null when no role predicate matches", () => {
    const ownerOnly = { owner: roles.owner };
    const sockets = [socket("mallory", "user", { connectionId: "m", connectedAt: 1 })];
    expect(toLiveConnections(sockets, ownerOnly, state)[0]?.role).toBeNull();
  });

  it("rejects sockets with an unknown callerType, no caller tag, or an invalid attachment", () => {
    const sockets = [
      socket("eve", "admin", { connectionId: "e", connectedAt: 1 }),
      { tags: ["callerType:user"], attachment: { connectionId: "x", connectedAt: 1 } },
      socket("carol", "user", { connectionId: "", connectedAt: 1 }),
      socket("dave", "user", { connectionId: "d", connectedAt: "yesterday" }),
      socket("frank", "user", null),
    ];
    expect(toLiveConnections(sockets, roles, state)).toEqual([]);
  });

  it("returns an empty list for no sockets", () => {
    expect(toLiveConnections([], roles, state)).toEqual([]);
  });
});

describe("isStudioSocket", () => {
  it("is true only for the __studio caller tag", () => {
    expect(isStudioSocket(["caller:__studio", "callerType:service"])).toBe(true);
    expect(isStudioSocket(["caller:__studio-impostor", "callerType:service"])).toBe(false);
    expect(isStudioSocket(["caller:alice", "callerType:user"])).toBe(false);
    expect(isStudioSocket([])).toBe(false);
  });
});

describe("readConnectionAttachment", () => {
  it("parses a valid attachment and rejects anything else", () => {
    expect(readConnectionAttachment({ connectionId: "c", connectedAt: 5 })).toEqual({
      connectionId: "c",
      connectedAt: 5,
    });
    expect(readConnectionAttachment(null)).toBeNull();
    expect(readConnectionAttachment({ connectionId: 1, connectedAt: 5 })).toBeNull();
  });
});
