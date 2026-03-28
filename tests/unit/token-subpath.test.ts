/**
 * Tests that token functions are accessible from @actor-kit/worker/token subpath export.
 * Task 4: Move token functions to opt-in export.
 */
import { createAccessToken, getCallerFromToken } from "@actor-kit/worker/token";
import { describe, expect, it } from "vitest";

const SECRET = "test-secret-at-least-32-chars-long!!";

describe("@actor-kit/worker/token subpath", () => {
  it("exports createAccessToken", () => {
    expect(typeof createAccessToken).toBe("function");
  });

  it("exports getCallerFromToken", () => {
    expect(typeof getCallerFromToken).toBe("function");
  });

  it("createAccessToken produces a valid JWT", async () => {
    const token = await createAccessToken({
      actorType: "counter",
      actorId: "counter-1",
      callerId: "user-1",
      callerType: "user",
      secret: SECRET,
    });

    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
  });

  it("getCallerFromToken round-trips with createAccessToken", async () => {
    const token = await createAccessToken({
      actorType: "counter",
      actorId: "counter-1",
      callerId: "user-1",
      callerType: "user",
      secret: SECRET,
    });

    const result = await getCallerFromToken(token, "counter", "counter-1", SECRET);
    expect(result.caller).toBe("user-1");
    expect(result.callerType).toBe("user");
  });
});
