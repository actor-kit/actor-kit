import { getTokenFromRequest } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

function makeRequest(protocolHeader?: string): Request {
  const headers = new Headers();
  if (protocolHeader !== undefined) {
    headers.set("Sec-WebSocket-Protocol", protocolHeader);
  }
  return new Request("https://example.com/", { headers });
}

describe("getTokenFromRequest", () => {
  it("returns null when no Sec-WebSocket-Protocol header", () => {
    expect(getTokenFromRequest(makeRequest())).toBeNull();
  });

  it("returns null when protocol is only actor-kit.v1", () => {
    expect(getTokenFromRequest(makeRequest("actor-kit.v1"))).toBeNull();
  });

  it("extracts token from 'actor-kit.v1, auth.xyz'", () => {
    expect(getTokenFromRequest(makeRequest("actor-kit.v1, auth.xyz"))).toBe("xyz");
  });

  it("extracts token from 'auth.xyz' (only protocol)", () => {
    expect(getTokenFromRequest(makeRequest("auth.xyz"))).toBe("xyz");
  });

  it("handles whitespace in comma-separated list", () => {
    expect(getTokenFromRequest(makeRequest("  actor-kit.v1  ,   auth.abc123  "))).toBe("abc123");
  });

  it("preserves dots/dashes in token: 'auth.eyJhbGc.foo.bar' → 'eyJhbGc.foo.bar'", () => {
    expect(getTokenFromRequest(makeRequest("actor-kit.v1, auth.eyJhbGc.foo.bar"))).toBe("eyJhbGc.foo.bar");
  });
});
