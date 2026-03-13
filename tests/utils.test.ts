import { afterEach, describe, expect, it } from "vitest";
import { createAccessToken } from "../src/createAccessToken";
import {
  assert,
  getCallerFromRequest,
  parseAccessTokenForCaller,
} from "../src/utils";

describe("utils", () => {
  afterEach(() => {
    delete globalThis.DEBUG_LEVEL;
  });

  it("reads bearer tokens from authorization headers", async () => {
    const token = await createAccessToken({
      signingKey: "super-secret",
      actorId: "list-1",
      actorType: "todo",
      callerId: "user-1",
      callerType: "client",
    });

    await expect(
      getCallerFromRequest(
        new Request("https://example.com/api/todo/list-1", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
        "todo",
        "list-1",
        "super-secret"
      )
    ).resolves.toEqual({
      id: "user-1",
      type: "client",
    });
  });

  it("reads websocket access tokens from the query string", async () => {
    const token = await createAccessToken({
      signingKey: "super-secret",
      actorId: "list-1",
      actorType: "todo",
      callerId: "service-1",
      callerType: "service",
    });

    await expect(
      getCallerFromRequest(
        new Request(
          `https://example.com/api/todo/list-1?accessToken=${encodeURIComponent(token)}`,
          {
            headers: {
              Upgrade: "websocket",
            },
          }
        ),
        "todo",
        "list-1",
        "super-secret"
      )
    ).resolves.toEqual({
      id: "service-1",
      type: "service",
    });
  });

  it("rejects malformed or mismatched access tokens", async () => {
    await expect(
      parseAccessTokenForCaller({
        accessToken: "bad-token",
        id: "list-1",
        type: "todo",
        secret: "super-secret",
      })
    ).rejects.toThrow();

    const token = await createAccessToken({
      signingKey: "super-secret",
      actorId: "list-1",
      actorType: "todo",
      callerId: "user-1",
      callerType: "client",
    });

    await expect(
      parseAccessTokenForCaller({
        accessToken: token,
        id: "list-1",
        type: "other-actor",
        secret: "super-secret",
      })
    ).rejects.toThrow("Expected accessToken audience to match actor type");
  });

  it("throws annotated assertion errors", () => {
    expect(() => assert(false, "Expected truthy value")).toThrow(
      "Expected truthy value"
    );
    expect(() => assert(true, "should not throw")).not.toThrow();
  });
});
