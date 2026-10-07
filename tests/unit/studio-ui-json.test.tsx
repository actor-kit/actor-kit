/**
 * @vitest-environment jsdom
 *
 * JsonTree / JsonDiff edge cases: empty and null values, deep nesting,
 * very large and very long data, ambiguous keys, key order.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { JsonDiff, computeDiff } from "../../packages/studio/ui/src/components/json-diff";
import { JsonTree } from "../../packages/studio/ui/src/components/json-tree";

afterEach(cleanup);

function tree(data: unknown) {
  return render(createElement(JsonTree, { data }));
}

describe("JsonTree", () => {
  it("renders null, empty object and empty array", () => {
    const { container } = tree({ a: null, b: {}, c: [] });
    expect(container.textContent).toContain("null");
    expect(container.textContent).toContain("{}");
    expect(container.textContent).toContain("[]");
  });

  it("renders zero, false and the empty string as values", () => {
    const { container } = tree({ zero: 0, no: false, empty: "" });
    expect(container.textContent).toContain("zero:0");
    expect(container.textContent).toContain("no:false");
    expect(container.textContent).toContain('empty:""');
  });

  it("renders a top-level primitive state", () => {
    expect(tree(42).container.textContent).toBe("42");
    expect(tree(null).container.textContent).toBe("null");
  });

  it("collapses deep nesting below level 2 and expands on click", () => {
    let deep: unknown = { leaf: "bottom" };
    for (let i = 0; i < 200; i++) deep = { next: deep };
    const { container } = tree(deep);
    expect(container.textContent).not.toContain("bottom");
    fireEvent.click(screen.getByText("{ 1 keys }"));
    expect(screen.getAllByText("{ 1 keys }").length).toBe(1);
  });

  it("shows only the first 100 items of a very large array, with a control to show more", () => {
    const big = Array.from({ length: 5_000 }, (_, i) => `item-${i}`);
    const { container } = tree({ big });
    expect(container.textContent).toContain('"item-99"');
    expect(container.textContent).not.toContain('"item-100"');
    fireEvent.click(screen.getByRole("button", { name: /show 100 more/i }));
    expect(container.textContent).toContain('"item-199"');
    expect(container.textContent).not.toContain('"item-200"');
    expect(screen.getByRole("button", { name: /show 100 more/i })).toBeTruthy();
  });

  it("shows only the first 100 keys of a very large object", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 1_000; i++) big[`k${i}`] = i;
    const { container } = tree(big);
    expect(container.textContent).toContain("k99:");
    expect(container.textContent).not.toContain("k100:");
    expect(screen.getByRole("button", { name: /show 100 more/i })).toBeTruthy();
  });

  it("truncates very long strings and expands them on click", () => {
    const long = "x".repeat(5_000);
    const { container } = tree({ long });
    expect(container.textContent?.length ?? 0).toBeLessThan(1_000);
    fireEvent.click(screen.getByRole("button", { name: /show all 5000 characters/i }));
    expect(container.textContent).toContain(long);
  });

  it("renders repeated (cyclic-looking) references to the same object", () => {
    const shared = { id: 1 };
    const { container } = tree([shared, shared, { a: shared, b: shared }]);
    // Level-1 objects are open; the shared object nested one level deeper renders collapsed.
    expect(container.textContent?.match(/id:1/g)?.length).toBe(2);
    expect(screen.getAllByText("{ 1 keys }").length).toBe(2);
  });
});

describe("JsonDiff", () => {
  it("reports no changes when only key order differs", () => {
    render(createElement(JsonDiff, { before: { a: 1, b: { c: 2, d: 3 } }, after: { b: { d: 3, c: 2 }, a: 1 } }));
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("diffs from a null previous state", () => {
    expect(computeDiff(null, { count: 1 })).toEqual([
      { path: "(root)", type: "changed", oldValue: null, newValue: { count: 1 } },
    ]);
  });

  it("diffs a change between object and array as one change", () => {
    expect(computeDiff({ a: [1] }, { a: { 0: 1 } })).toEqual([
      { path: "a", type: "changed", oldValue: [1], newValue: { 0: 1 } },
    ]);
  });

  it("treats 0 → null and '' → null as changes", () => {
    expect(computeDiff({ a: 0, b: "" }, { a: null, b: null }).map((d) => d.path)).toEqual(["a", "b"]);
  });

  it("distinguishes a dotted key from a nested path", () => {
    const flat = computeDiff({ "a.b": 1 }, { "a.b": 2 });
    const nested = computeDiff({ a: { b: 1 } }, { a: { b: 2 } });
    expect(flat[0]?.path).not.toBe(nested[0]?.path);
    expect(nested[0]?.path).toBe("a.b");
    expect(flat[0]?.path).toBe('["a.b"]');
  });

  it("caps a huge diff at 200 rows and says how many were hidden", () => {
    const before = { items: Array.from({ length: 1_000 }, (_, i) => i) };
    const after = { items: Array.from({ length: 1_000 }, (_, i) => i + 1) };
    const { container } = render(createElement(JsonDiff, { before, after }));
    expect(container.querySelectorAll("[data-diff-row]").length).toBe(200);
    expect(container.textContent).toContain("800 more changes");
  });

  it("shows a very long changed string truncated", () => {
    const { container } = render(
      createElement(JsonDiff, { before: { s: "a".repeat(10_000) }, after: { s: "b".repeat(10_000) } }),
    );
    expect(container.textContent?.length ?? 0).toBeLessThan(1_000);
  });
});
