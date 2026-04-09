/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUrl, inferProtocol } from "../../packages/client/src/url";

describe("buildUrl", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("uses window.location.host when host is omitted (localhost)", () => {
    (globalThis as { window?: unknown }).window = { location: { host: "localhost:3000" } };
    expect(buildUrl("/api/counter/abc")).toBe("ws://localhost:3000/api/counter/abc");
  });

  it("uses explicit host when provided (cross-origin)", () => {
    (globalThis as { window?: unknown }).window = { location: { host: "frontend.example.com" } };
    expect(buildUrl("/api/x", "api.example.com")).toBe("wss://api.example.com/api/x");
  });

  it("IPv4 host → ws", () => {
    expect(buildUrl("/x", "192.168.1.10:8787")).toBe("ws://192.168.1.10:8787/x");
  });

  it("IPv6 host → ws", () => {
    expect(buildUrl("/x", "[::1]:8787")).toBe("ws://[::1]:8787/x");
  });

  it("localhost → ws", () => {
    expect(buildUrl("/x", "localhost")).toBe("ws://localhost/x");
  });

  it("example.com → wss", () => {
    expect(buildUrl("/x", "example.com")).toBe("wss://example.com/x");
  });

  it("localhost:8787 → ws", () => {
    expect(buildUrl("/x", "localhost:8787")).toBe("ws://localhost:8787/x");
  });

  it("normalizes path missing leading slash", () => {
    expect(buildUrl("api/x", "example.com")).toBe("wss://example.com/api/x");
  });

  it("throws when no host and no window", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => buildUrl("/x")).toThrow(/host is required/);
  });
});

describe("inferProtocol", () => {
  it("localhost → ws", () => {
    expect(inferProtocol("localhost")).toBe("ws");
    expect(inferProtocol("localhost:8787")).toBe("ws");
  });

  it("IPv4 → ws", () => {
    expect(inferProtocol("127.0.0.1")).toBe("ws");
    expect(inferProtocol("10.0.0.1:80")).toBe("ws");
  });

  it("IPv6 → ws", () => {
    expect(inferProtocol("[::1]")).toBe("ws");
    expect(inferProtocol("[::1]:8787")).toBe("ws");
  });

  it("public hostname → wss", () => {
    expect(inferProtocol("example.com")).toBe("wss");
    expect(inferProtocol("api.example.com:443")).toBe("wss");
  });
});
