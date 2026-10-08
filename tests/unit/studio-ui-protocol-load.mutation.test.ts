/**
 * Loads the Studio protocol module inside a test, so a schema that fails
 * while the module is being built shows up as a failing test (not an
 * unloadable file), then checks a connect/disconnect round trip.
 */
import { expect, it } from "vitest";

it("builds the frame schemas and parses connection frames", async () => {
  const { parseStudioFrame } = await import("../../packages/studio/ui/src/protocol");
  const connection = { connectionId: "s1", caller: "u1", callerType: "service", connectedAt: 3, role: null };
  expect(parseStudioFrame(JSON.stringify({ type: "studio.connection", action: "connect", connection }))).toEqual({
    kind: "frame",
    frame: { type: "studio.connection", action: "connect", connection },
  });
  expect(parseStudioFrame(JSON.stringify({ type: "studio.connection", action: "disconnect", connection }))).toEqual({
    kind: "frame",
    frame: {
      type: "studio.connection",
      action: "disconnect",
      connection: { connectionId: "s1", caller: "u1", callerType: "service" },
    },
  });
});
