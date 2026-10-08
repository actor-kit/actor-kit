import { withCallerIdentity } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

function spoofed(): Request {
  return new Request("https://example.com/api/room/1", {
    headers: {
      "x-actor-kit-caller-id": "attacker",
      "x-actor-kit-caller-type": "service",
      "x-actor-kit-binary": "1",
      accept: "text/plain",
    },
  });
}

function headerList(request: Request): Array<[string, string]> {
  return [...request.headers.entries()];
}

describe("withCallerIdentity binary flag", () => {
  it("scrubs a spoofed binary flag when the identity does not support binary", () => {
    const result = withCallerIdentity(spoofed(), { callerId: "u-1", callerType: "user" });
    expect(headerList(result)).toEqual([
      ["accept", "text/plain"],
      ["x-actor-kit-caller-id", "u-1"],
      ["x-actor-kit-caller-type", "user"],
    ]);
  });

  it("scrubs a spoofed binary flag when supportsBinary is false", () => {
    const result = withCallerIdentity(spoofed(), { callerId: "u-1", callerType: "user", supportsBinary: false });
    expect(result.headers.has("X-Actor-Kit-Binary")).toBe(false);
  });

  it("stamps the binary flag as 1 when the identity supports binary", () => {
    const request = new Request("https://example.com/api/room/1");
    const result = withCallerIdentity(request, { callerId: "s-1", callerType: "service", supportsBinary: true });
    expect(headerList(result)).toEqual([
      ["x-actor-kit-binary", "1"],
      ["x-actor-kit-caller-id", "s-1"],
      ["x-actor-kit-caller-type", "service"],
    ]);
  });

  it("replaces spoofed identity headers with exactly one verified value each", () => {
    const result = withCallerIdentity(spoofed(), { callerId: "u-2", callerType: "user", supportsBinary: true });
    expect(headerList(result)).toEqual([
      ["accept", "text/plain"],
      ["x-actor-kit-binary", "1"],
      ["x-actor-kit-caller-id", "u-2"],
      ["x-actor-kit-caller-type", "user"],
    ]);
  });
});
