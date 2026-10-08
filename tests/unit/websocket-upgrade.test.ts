/** The actor's WebSocket check: header names and the "websocket" token are case-insensitive (RFC 7230 §6.7). */
import { isWebSocketUpgrade } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

const withUpgrade = (value?: string) =>
  new Request("http://localhost/", value === undefined ? {} : { headers: { Upgrade: value } });

describe("isWebSocketUpgrade", () => {
  it.each(["websocket", "WebSocket", "WEBSOCKET"])("accepts Upgrade: %s", (value) => {
    expect(isWebSocketUpgrade(withUpgrade(value))).toBe(true);
  });

  it.each(["h2c", "websockets", ""])("refuses Upgrade: %j", (value) => {
    expect(isWebSocketUpgrade(withUpgrade(value))).toBe(false);
  });

  it("refuses a request without an Upgrade header", () => {
    expect(isWebSocketUpgrade(withUpgrade())).toBe(false);
  });
});
