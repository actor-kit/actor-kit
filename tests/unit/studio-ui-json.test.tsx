/**
 * @vitest-environment jsdom
 *
 * JsonTree / JsonDiff edge cases: empty and null values, deep nesting,
 * very large and very long data, ambiguous keys, key order.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

describe("JsonDiff colours (spec: added=green, removed=red, changed=yellow)", () => {
  const INDEX_CSS = resolve(__dirname, "../../packages/studio/ui/src/index.css");

  /** Every class token used by the coloured spans of the row for `path`. */
  function rowClasses(container: HTMLElement, path: string): { type: string | null; classes: string[] } {
    const row = Array.from(container.querySelectorAll("[data-diff-row]")).find(
      (r) => r.firstElementChild?.textContent === path,
    );
    if (row === undefined) throw new Error(`no diff row for ${path}`);
    const spans = Array.from(row.querySelectorAll("span")).slice(1); // skip the path label
    return {
      type: row.getAttribute("data-diff-type"),
      classes: spans.flatMap((s) => s.className.split(/\s+/)).filter((c) => c.startsWith("text-")),
    };
  }

  function renderAllThree() {
    return render(
      createElement(JsonDiff, {
        before: { kept: 1, gone: "x", n: 1 },
        after: { kept: 1, n: 2, fresh: "y" },
      }),
    ).container;
  }

  it("renders a changed row with the changed (yellow) treatment only", () => {
    const { type, classes } = rowClasses(renderAllThree(), "n");
    expect(classes.length).toBeGreaterThan(0);
    for (const c of classes) expect(c).toMatch(/^text-diff-changed(\/\d+)?$|^text-zinc-/);
    expect(classes.some((c) => c.startsWith("text-diff-changed"))).toBe(true);
    expect(type).toBe("changed");
  });

  it("renders added rows green-token and removed rows red-token, never the changed token", () => {
    const container = renderAllThree();
    const added = rowClasses(container, "fresh");
    const removed = rowClasses(container, "gone");
    expect(added.type).toBe("added");
    expect(removed.type).toBe("removed");
    expect(added.classes.length).toBeGreaterThan(0);
    expect(removed.classes.length).toBeGreaterThan(0);
    for (const c of added.classes) expect(c).toMatch(/^text-diff-added(\/\d+)?$/);
    for (const c of removed.classes) expect(c).toMatch(/^text-diff-removed(\/\d+)?$/);
  });

  it("defines the three diff colour tokens in the Studio theme (index.css), changed = yellow/amber", () => {
    const css = readFileSync(INDEX_CSS, "utf8");
    expect(css).toMatch(/--color-diff-added:\s*var\(--color-(emerald|green)-\d+\)/);
    expect(css).toMatch(/--color-diff-removed:\s*var\(--color-red-\d+\)/);
    expect(css).toMatch(/--color-diff-changed:\s*var\(--color-(yellow|amber)-\d+\)/);
  });
});

describe("computeDiff: arrays of primitives that change length are aligned, not compared by index", () => {
  it("removing the middle item is one removed row", () => {
    expect(computeDiff({ onlineUsers: ["alice", "bob", "carol"] }, { onlineUsers: ["alice", "carol"] })).toEqual([
      { path: "onlineUsers[1]", type: "removed", oldValue: "bob" },
    ]);
  });

  it("removing the first item is one removed row", () => {
    expect(computeDiff(["alice", "bob", "carol"], ["bob", "carol"])).toEqual([
      { path: "[0]", type: "removed", oldValue: "alice" },
    ]);
  });

  it("inserting in the middle is one added row at its new index", () => {
    expect(computeDiff([1, 3], [1, 2, 3])).toEqual([{ path: "[1]", type: "added", newValue: 2 }]);
  });

  it("removing and appending several items", () => {
    expect(computeDiff(["a", "b", "c", "d"], ["a", "d"])).toEqual([
      { path: "[1]", type: "removed", oldValue: "b" },
      { path: "[2]", type: "removed", oldValue: "c" },
    ]);
    expect(computeDiff(["a"], ["a", "b", "c"])).toEqual([
      { path: "[1]", type: "added", newValue: "b" },
      { path: "[2]", type: "added", newValue: "c" },
    ]);
  });

  it("a replaced item next to a removal is a changed row plus a removed row", () => {
    expect(computeDiff(["a", "b", "c", "d"], ["a", "x", "d"])).toEqual([
      { path: "[1]", type: "changed", oldValue: "b", newValue: "x" },
      { path: "[2]", type: "removed", oldValue: "c" },
    ]);
  });

  it("keeps duplicates straight", () => {
    expect(computeDiff(["x", "x", "y"], ["x", "y"])).toEqual([{ path: "[1]", type: "removed", oldValue: "x" }]);
  });

  it("removing one item from a long array is one row", () => {
    const before = Array.from({ length: 5_000 }, (_, i) => i);
    const after = before.filter((i) => i !== 2_500);
    expect(computeDiff(before, after)).toEqual([{ path: "[2500]", type: "removed", oldValue: 2_500 }]);
  });

  it("long arrays with nothing in common still diff every slot", () => {
    const before = Array.from({ length: 2_000 }, (_, i) => `b${i}`);
    const after = Array.from({ length: 1_999 }, (_, i) => `a${i}`);
    const diffs = computeDiff(before, after);
    expect(diffs).toHaveLength(2_000);
    expect(diffs.filter((d) => d.type === "changed")).toHaveLength(1_999);
    expect(diffs.at(-1)).toEqual({ path: "[1999]", type: "removed", oldValue: "b1999" });
  });

  it("same-length arrays are still compared by index (in-place edits)", () => {
    expect(computeDiff(["a", "b"], ["b", "a"])).toEqual([
      { path: "[0]", type: "changed", oldValue: "a", newValue: "b" },
      { path: "[1]", type: "changed", oldValue: "b", newValue: "a" },
    ]);
  });

  it("arrays holding objects are still compared by index", () => {
    expect(computeDiff([{ id: 1 }, { id: 2 }], [{ id: 2 }])).toEqual([
      { path: "[0].id", type: "changed", oldValue: 1, newValue: 2 },
      { path: "[1]", type: "removed", oldValue: { id: 2 } },
    ]);
  });

  it("renders bob leaving as a single red removed row", () => {
    const { container } = render(
      createElement(JsonDiff, { before: { onlineUsers: ["alice", "bob", "carol"] }, after: { onlineUsers: ["alice", "carol"] } }),
    );
    const rows = container.querySelectorAll("[data-diff-row]");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("data-diff-type")).toBe("removed");
    expect(rows[0]?.textContent).toBe('onlineUsers[1]-"bob"');
  });
});
