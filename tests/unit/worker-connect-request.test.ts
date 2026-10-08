/**
 * The pure parts of the actor's WebSocket handling: what a connect request carries, which close
 * code answers a client's close, and the shape check createActorClass() runs on a definition.
 */
import { ACTOR_KIT_PROTOCOL, closeCodeToSend, hasActorDefShape, parseConnectRequest } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

const request = (headers: Record<string, string>) => new Request("http://localhost/", { headers });
const identity = { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": "u1", "X-Actor-Kit-Caller-Type": "user" };

describe("parseConnectRequest", () => {
  it("reads the caller, caller type, binary support and subprotocol", () => {
    expect(parseConnectRequest(request(identity))).toEqual({
      ok: true,
      caller: "u1",
      callerType: "user",
      binary: false,
      protocol: null,
    });
    const full = request({
      ...identity,
      "X-Actor-Kit-Caller-Type": "service",
      "X-Actor-Kit-Binary": "1",
      "Sec-WebSocket-Protocol": `auth.abc , ${ACTOR_KIT_PROTOCOL}`,
    });
    expect(parseConnectRequest(full)).toEqual({
      ok: true,
      caller: "u1",
      callerType: "service",
      binary: true,
      protocol: "actor-kit.v1",
    });
  });

  it('answers only the Actor Kit subprotocol, and binary only for exactly "1"', () => {
    const other = parseConnectRequest(
      request({ ...identity, "Sec-WebSocket-Protocol": "chat", "X-Actor-Kit-Binary": "true" }),
    );
    expect(other).toMatchObject({ ok: true, protocol: null, binary: false });
  });

  it.each([
    ["no upgrade", { ...identity, Upgrade: "h2c" }, 426, "Expected WebSocket"],
    ["no caller", { ...identity, "X-Actor-Kit-Caller-Id": "" }, 401, "Missing caller identity"],
    ["no caller type", { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": "u1" }, 401, "Missing caller identity"],
    ["a bad caller type", { ...identity, "X-Actor-Kit-Caller-Type": "admin" }, 401, "Invalid caller type"],
  ])("refuses %s", (_what, headers, status, message) => {
    expect(parseConnectRequest(request(headers))).toEqual({ ok: false, status, message });
  });
});

describe("closeCodeToSend", () => {
  it.each([1000, 1001, 1004, 1007, 1014, 3000, 4000, 4999])("echoes %i", (code) => {
    expect(closeCodeToSend(code)).toBe(code);
  });

  it.each([undefined, 999, 1005, 1006, 1015, 2999, 5000])("answers %s with 1000", (code) => {
    expect(closeCodeToSend(code)).toBe(1000);
  });
});

describe("hasActorDefShape", () => {
  const def = { input: {}, init: () => ({}), roles: {}, views: {} };

  it("accepts a definition with input, init, roles and views, with or without links", () => {
    expect(hasActorDefShape(def)).toBe(true);
    expect(hasActorDefShape({ ...def, links: undefined })).toBe(true);
    expect(hasActorDefShape({ ...def, links: { feed: { contract: {}, onUpdate: () => ({}) } } })).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "def"],
    ["a missing input", { ...def, input: undefined }],
    ["a null roles", { ...def, roles: null }],
    ["a non-object views", { ...def, views: "x" }],
    ["a non-function init", { ...def, init: {} }],
    ["null links", { ...def, links: null }],
    ["a link that is not an object", { ...def, links: { feed: 1 } }],
    ["a link without onUpdate", { ...def, links: { feed: { contract: {} } } }],
    ["a link without contract", { ...def, links: { feed: { onUpdate: () => ({}) } } }],
  ])("refuses %s", (_what, value) => {
    expect(hasActorDefShape(value)).toBe(false);
  });
});
