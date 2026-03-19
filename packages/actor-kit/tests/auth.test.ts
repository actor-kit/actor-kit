import { describe, expect, it } from "vitest";
import { createAccessToken } from "../src/createAccessToken";
import { parseAccessTokenForCaller } from "../src/utils";

describe("access tokens", () => {
  it("round-trips caller identity through token signing and verification", async () => {
    const token = await createAccessToken({
      signingKey: "super-secret",
      actorId: "list-123",
      actorType: "todo",
      callerId: "user-42",
      callerType: "client",
    });

    await expect(
      parseAccessTokenForCaller({
        accessToken: token,
        id: "list-123",
        type: "todo",
        secret: "super-secret",
      })
    ).resolves.toEqual({
      id: "user-42",
      type: "client",
    });
  });

  it("rejects tokens for the wrong actor id", async () => {
    const token = await createAccessToken({
      signingKey: "super-secret",
      actorId: "list-123",
      actorType: "todo",
      callerId: "user-42",
      callerType: "client",
    });

    await expect(
      parseAccessTokenForCaller({
        accessToken: token,
        id: "different-list",
        type: "todo",
        secret: "super-secret",
      })
    ).rejects.toThrow("Expected JTI on accessToken to match actor id");
  });
});
