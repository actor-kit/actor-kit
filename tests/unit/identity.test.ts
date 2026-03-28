import { withCallerIdentity } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("withCallerIdentity", () => {
  it("sets X-Actor-Kit-Caller-Id header", () => {
    const original = new Request("https://example.com/api/actor");
    const result = withCallerIdentity(original, {
      callerId: "user-123",
      callerType: "user",
    });

    expect(result.headers.get("X-Actor-Kit-Caller-Id")).toBe("user-123");
  });

  it("sets X-Actor-Kit-Caller-Type header", () => {
    const original = new Request("https://example.com/api/actor");
    const result = withCallerIdentity(original, {
      callerId: "user-123",
      callerType: "service",
    });

    expect(result.headers.get("X-Actor-Kit-Caller-Type")).toBe("service");
  });

  it("scrubs existing X-Actor-Kit-Caller-Id header from inbound request", () => {
    const original = new Request("https://example.com/api/actor", {
      headers: {
        "X-Actor-Kit-Caller-Id": "attacker-spoofed-id",
      },
    });
    const result = withCallerIdentity(original, {
      callerId: "real-user-456",
      callerType: "user",
    });

    expect(result.headers.get("X-Actor-Kit-Caller-Id")).toBe("real-user-456");
  });

  it("scrubs existing X-Actor-Kit-Caller-Type header from inbound request", () => {
    const original = new Request("https://example.com/api/actor", {
      headers: {
        "X-Actor-Kit-Caller-Type": "service",
      },
    });
    const result = withCallerIdentity(original, {
      callerId: "user-123",
      callerType: "user",
    });

    expect(result.headers.get("X-Actor-Kit-Caller-Type")).toBe("user");
  });

  it("preserves request method", () => {
    const original = new Request("https://example.com/api/actor", {
      method: "POST",
    });
    const result = withCallerIdentity(original, {
      callerId: "user-123",
      callerType: "user",
    });

    expect(result.method).toBe("POST");
  });

  it("preserves request URL", () => {
    const original = new Request("https://example.com/api/actor?foo=bar");
    const result = withCallerIdentity(original, {
      callerId: "user-123",
      callerType: "user",
    });

    expect(result.url).toBe("https://example.com/api/actor?foo=bar");
  });

  it("preserves request body", async () => {
    const body = JSON.stringify({ input: { name: "test" } });
    const original = new Request("https://example.com/api/actor", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    });
    const result = withCallerIdentity(original, {
      callerId: "user-123",
      callerType: "user",
    });

    const resultBody = await result.text();
    expect(resultBody).toBe(body);
  });

  it("preserves other existing headers", () => {
    const original = new Request("https://example.com/api/actor", {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer some-token",
      },
    });
    const result = withCallerIdentity(original, {
      callerId: "user-123",
      callerType: "user",
    });

    expect(result.headers.get("Content-Type")).toBe("application/json");
    expect(result.headers.get("Authorization")).toBe("Bearer some-token");
  });

  it("returns a new Request without mutating original headers", () => {
    const original = new Request("https://example.com/api/actor", {
      headers: { "X-Custom": "keep" },
    });
    const result = withCallerIdentity(original, {
      callerId: "user-123",
      callerType: "user",
    });

    expect(result).not.toBe(original);
    // Original headers must not have identity stamped
    expect(original.headers.get("X-Actor-Kit-Caller-Id")).toBeNull();
    expect(original.headers.get("X-Custom")).toBe("keep");
  });

  it("scrubs all X-Actor-Kit headers even with mixed case", () => {
    // Headers are case-insensitive per HTTP spec
    const original = new Request("https://example.com/api/actor", {
      headers: {
        "x-actor-kit-caller-id": "spoofed",
        "x-actor-kit-caller-type": "service",
      },
    });
    const result = withCallerIdentity(original, {
      callerId: "real-user",
      callerType: "user",
    });

    expect(result.headers.get("X-Actor-Kit-Caller-Id")).toBe("real-user");
    expect(result.headers.get("X-Actor-Kit-Caller-Type")).toBe("user");
  });
});
