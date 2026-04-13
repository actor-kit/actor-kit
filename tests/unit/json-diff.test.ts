import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
// Import directly to avoid cloudflare:workers dependency chain
import { JsonDiff } from "../../packages/studio/ui/src/components/json-diff";

/** Render JsonDiff and return the HTML string for assertion. */
function renderDiff(before: unknown, after: unknown): string {
  return renderToString(createElement(JsonDiff, { before, after }));
}

describe("JsonDiff", () => {
  it("shows no changes when values are identical", () => {
    const html = renderDiff({ count: 5 }, { count: 5 });
    expect(html).toContain("No changes");
  });

  it("shows changed primitive field", () => {
    const html = renderDiff({ count: 5 }, { count: 6 });
    expect(html).toContain("count");
    expect(html).toContain("5");
    expect(html).toContain("6");
  });

  it("shows added field", () => {
    const html = renderDiff({ count: 5 }, { count: 5, name: "alice" });
    expect(html).toContain("name");
    expect(html).toContain("alice");
    expect(html).toContain("+"); // added indicator
  });

  it("shows removed field", () => {
    const html = renderDiff({ count: 5, name: "alice" }, { count: 5 });
    expect(html).toContain("name");
    expect(html).toContain("-"); // removed indicator
  });

  it("handles nested object changes", () => {
    const html = renderDiff({ user: { name: "alice", score: 10 } }, { user: { name: "alice", score: 20 } });
    expect(html).toContain("user.score");
    expect(html).toContain("10");
    expect(html).toContain("20");
  });

  it("handles array element changes", () => {
    const html = renderDiff({ items: [1, 2, 3] }, { items: [1, 2, 4] });
    expect(html).toContain("items[2]");
    expect(html).toContain("3");
    expect(html).toContain("4");
  });

  it("handles array length increase", () => {
    const html = renderDiff({ items: [1] }, { items: [1, 2] });
    expect(html).toContain("items[1]");
    expect(html).toContain("+");
  });

  it("handles array length decrease", () => {
    const html = renderDiff({ items: [1, 2] }, { items: [1] });
    expect(html).toContain("items[1]");
    expect(html).toContain("-");
  });

  it("handles null to value change", () => {
    const html = renderDiff({ name: null }, { name: "bob" });
    expect(html).toContain("name");
    expect(html).toContain("null");
    expect(html).toContain("bob");
  });

  it("handles multiple changes", () => {
    const html = renderDiff({ count: 1, status: "idle" }, { count: 2, status: "active" });
    expect(html).toContain("count");
    expect(html).toContain("status");
  });
});
