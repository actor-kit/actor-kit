import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccessToken } from "@actor-kit/server";
import {
  assert,
  debug,
  error,
  getCallerFromRequest,
  getSnapshot,
  json,
  LogLevel,
  logError,
  logInfo,
  logWarn,
  notFound,
  parseAccessTokenForCaller,
  parseQueryParams,
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

  it("logs at or above the configured log level", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    globalThis.DEBUG_LEVEL = LogLevel.WARN;

    debug("skip debug", LogLevel.DEBUG);
    logWarn("warn message", { traceId: "1" });
    logError("error message");
    logInfo("skip info");

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]?.[0]).toContain("WARN: warn message");
    expect(logSpy.mock.calls[0]?.[1]).toEqual({ traceId: "1" });
    expect(logSpy.mock.calls[1]?.[0]).toContain("ERROR: error message");
  });

  it("builds JSON error helpers and parses query params", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const okResponse = json({ ok: true }, 201);
    expect(okResponse.status).toBe(201);
    await expect(okResponse.json()).resolves.toEqual({ ok: true });

    const stringError = error("Boom", 418);
    expect(stringError.status).toBe(418);
    await expect(stringError.json()).resolves.toEqual({
      ok: false,
      error: "Boom",
    });

    const objectError = error({}, 500);
    await expect(objectError.json()).resolves.toEqual({
      ok: false,
      error: "Unknown error",
    });

    const missing = notFound();
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      ok: false,
      error: "Not found",
    });

    const params = parseQueryParams("https://example.com/path?foo=bar&baz=qux");
    expect(params.get("foo")).toBe("bar");
    expect(parseQueryParams("https://example.com/path").toString()).toBe("");
    expect(errorSpy).toHaveBeenCalledTimes(3);
  });

  it("returns actor snapshots through the helper", () => {
    const actor = {
      getSnapshot: () => ({ value: "ready", context: { public: {}, private: {} } }),
    };

    expect(getSnapshot(actor as never)).toEqual({
      value: "ready",
      context: { public: {}, private: {} },
    });
  });
});
