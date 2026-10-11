/**
 * ADR-019 C through a real Durable Object: a view with an enum, a record, a union and json is sent
 * as a binary snapshot, then as deltas (a record key added, changed and removed; a union variant
 * changed then patched), and each decodes to the server's view with the same checksum text.
 */
import { env } from "cloudflare:test";
import { applyDelta, decode, FrameType, type Infer, parseFrame } from "@actor-kit/core";
import { describe, expect, it } from "vitest";
import { ScoreboardView } from "./src/rich-view-actors";

type View = Infer<typeof ScoreboardView>;

function nextBinary(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (event) => {
        if (event.data instanceof ArrayBuffer) resolve(new Uint8Array(event.data));
      },
      { once: true },
    );
  });
}

async function connect(actorId: string) {
  const stub = env.SCOREBOARD.get(env.SCOREBOARD.idFromName(actorId));
  await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });
  const response = await stub.fetch(`http://localhost/api/scoreboard/${actorId}`, {
    headers: {
      Upgrade: "websocket",
      "X-Actor-Kit-Caller-Id": "u1",
      "X-Actor-Kit-Caller-Type": "user",
      "X-Actor-Kit-Binary": "1",
    },
  });
  const ws = response.webSocket;
  if (ws === null) throw new Error("expected a WebSocket upgrade");
  const first = nextBinary(ws);
  ws.accept();
  return { ws, first: await first };
}

async function step(ws: WebSocket, view: View, message: Record<string, unknown>): Promise<View> {
  const next = nextBinary(ws);
  ws.send(JSON.stringify(message));
  const frame = parseFrame(await next);
  expect(frame.type).toBe(FrameType.DELTA);
  return applyDelta(ScoreboardView, view, frame.payload);
}

describe("richer view schemas (integration)", () => {
  it("syncs records, unions, enums and json through snapshot and deltas", async () => {
    const { ws, first } = await connect("rich-1");
    const snapshot = parseFrame(first);
    expect(snapshot.type).toBe(FrameType.SNAPSHOT);
    let view = decode(ScoreboardView, snapshot.payload);
    expect(view).toEqual({ phase: "lobby", scores: {}, turn: { kind: "waiting" }, meta: { tags: [] } });

    view = await step(ws, view, { type: "SCORE", player: "ann", points: -5 });
    view = await step(ws, view, { type: "SCORE", player: "bo", points: 3 });
    view = await step(ws, view, { type: "SCORE", player: "ann", points: 2 });
    expect(view.scores).toEqual({ ann: -3, bo: 3 });
    expect(view.phase).toBe("playing");

    view = await step(ws, view, { type: "ACT", player: 1, seconds: 30 });
    view = await step(ws, view, { type: "ACT", player: 1, seconds: 29 });
    expect(view.turn).toEqual({ kind: "acting", player: 1, seconds: 29 });

    view = await step(ws, view, { type: "REMOVE", player: "ann" });
    expect(JSON.stringify(view)).toBe(
      JSON.stringify({
        phase: "playing",
        scores: { bo: 3 },
        turn: { kind: "acting", player: 1, seconds: 29 },
        meta: { tags: ["removed:ann"] },
      }),
    );

    ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  });
});
