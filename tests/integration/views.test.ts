import { env } from "cloudflare:test";
import { decode, FrameType, parseFrame, schema, string, uint32 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

const CounterView = schema({ count: uint32, lastCaller: string });

function getStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return { stub: env.COUNTER.get(id), actorId: name };
}

describe("View computation through DO runtime", () => {
  it("getSnapshot returns view with correct role", async () => {
    const { stub, actorId } = getStub("view-role-1");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });
    await stub.send("u1", "user", { type: "INCREMENT", amount: 7 });

    const userView = await stub.getSnapshot("u1", "user");
    expect(userView.role).toBe("user");
    expect((userView.snapshot as { count: number }).count).toBe(7);
    expect((userView.snapshot as { lastCaller: string }).lastCaller).toBe("u1");
  });

  it("checksum changes when state changes", async () => {
    const { stub, actorId } = getStub("view-checksum-1");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const before = await stub.getSnapshot("u1", "user");
    await stub.send("u1", "user", { type: "INCREMENT", amount: 1 });
    const after = await stub.getSnapshot("u1", "user");

    expect(before.checksum).not.toBe(after.checksum);
  });

  it("same state produces same checksum", async () => {
    const { stub, actorId } = getStub("view-checksum-stable");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const snap1 = await stub.getSnapshot("u1", "user");
    const snap2 = await stub.getSnapshot("u1", "user");

    expect(snap1.checksum).toBe(snap2.checksum);
  });

  it("binary snapshot via WebSocket decodes to correct view", async () => {
    const { stub, actorId } = getStub("view-binary-ws");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });
    await stub.send("u1", "user", { type: "INCREMENT", amount: 42 });

    const response = await stub.fetch(`http://localhost/api/counter/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "X-Actor-Kit-Caller-Id": "u1",
        "X-Actor-Kit-Caller-Type": "user",
        "X-Actor-Kit-Binary": "1",
      },
    });

    const ws = response.webSocket!;
    ws.accept();

    const data = await new Promise<ArrayBuffer>((resolve) => {
      ws.addEventListener(
        "message",
        (event) => {
          if (event.data instanceof ArrayBuffer) resolve(event.data);
          else resolve(new TextEncoder().encode(event.data as string).buffer);
        },
        { once: true },
      );
    });

    const frame = parseFrame(new Uint8Array(data));
    expect(frame.type).toBe(FrameType.SNAPSHOT);

    const view = decode(CounterView, frame.payload);
    expect((view as { count: number }).count).toBe(42);

    ws.close(1000, "done");
    await new Promise((r) => setTimeout(r, 50));
  });
});
