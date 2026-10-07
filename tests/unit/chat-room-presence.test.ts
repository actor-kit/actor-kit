/**
 * examples/chat-room lifecycle handlers: presence is per user, connections are per socket.
 * The runtime passes `callerConnections` (the caller's open sockets after the event).
 */
import { describe, expect, it } from "vitest";
import { ChatRoomContract } from "../../examples/chat-room/src/chat";

const { connect, disconnect } = ChatRoomContract.def.lifecycle;
const empty = ChatRoomContract.def.init();
const alice = (callerConnections: number) => ({ caller: "alice", callerType: "user" as const, callerConnections });

describe("chat-room presence handlers", () => {
  it("a first connect puts the user online", () => {
    expect(connect(empty, alice(1)).onlineUsers).toEqual(["alice"]);
  });

  it("a second tab does not list the user twice and leaves state untouched", () => {
    const online = connect(empty, alice(1));
    expect(connect(online, alice(2))).toBe(online);
  });

  it("closing one of two tabs keeps the user online and leaves state untouched", () => {
    const online = connect(connect(empty, alice(1)), alice(2));
    expect(disconnect(online, alice(1))).toBe(online);
  });

  it("closing the last tab takes the user offline", () => {
    const online = connect(empty, alice(1));
    expect(disconnect(online, alice(0)).onlineUsers).toEqual([]);
  });

  it("only the leaving user is removed", () => {
    const both = connect(connect(empty, alice(1)), { caller: "bob", callerType: "user", callerConnections: 1 });
    expect(disconnect(both, alice(0)).onlineUsers).toEqual(["bob"]);
  });
});
