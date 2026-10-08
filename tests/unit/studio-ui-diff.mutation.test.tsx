/**
 * @vitest-environment jsdom
 *
 * computeDiff and JsonDiff: object keys, index diffs, aligned primitive
 * arrays (checked against a reference LCS), value formatting and row caps.
 */
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIFF_VALUE_PREVIEW_LENGTH,
  type DiffEntry,
  JsonDiff,
  MAX_DIFF_ROWS,
  computeDiff,
} from "../../packages/studio/ui/src/components/json-diff";

afterEach(cleanup);

describe("computeDiff: objects", () => {
  it("reports nothing for identical or equal values", () => {
    const same = { a: 1 };
    expect(computeDiff(same, same)).toEqual([]);
    expect(computeDiff({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
  });

  it("reports added, removed and nested changed keys with dotted paths", () => {
    expect(computeDiff({ a: 1, b: { c: 1 }, gone: true }, { a: 1, b: { c: 2 }, added: null })).toEqual([
      { path: "b.c", type: "changed", oldValue: 1, newValue: 2 },
      { path: "gone", type: "removed", oldValue: true },
      { path: "added", type: "added", newValue: null },
    ]);
  });

  it("uses bracket notation for keys that are not identifiers", () => {
    expect(computeDiff({ "a b": 1, $ok: 1, _x1: 1, "1a": 1 }, { "a b": 2, $ok: 2, _x1: 2, "1a": 2 })).toEqual([
      { path: '["a b"]', type: "changed", oldValue: 1, newValue: 2 },
      { path: "$ok", type: "changed", oldValue: 1, newValue: 2 },
      { path: "_x1", type: "changed", oldValue: 1, newValue: 2 },
      { path: '["1a"]', type: "changed", oldValue: 1, newValue: 2 },
    ]);
    expect(computeDiff({ o: { "x-y": 1 } }, { o: { "x-y": 2 } })[0]?.path).toBe('o["x-y"]');
  });

  it("treats keys named like Object.prototype members as ordinary keys", () => {
    expect(computeDiff({}, { toString: 1, constructor: "x" })).toEqual([
      { path: "toString", type: "added", newValue: 1 },
      { path: "constructor", type: "added", newValue: "x" },
    ]);
    expect(computeDiff({ hasOwnProperty: 1 }, {})).toEqual([
      { path: "hasOwnProperty", type: "removed", oldValue: 1 },
    ]);
  });

  it("labels a top-level primitive change as the root", () => {
    expect(computeDiff(1, 2)).toEqual([{ path: "(root)", type: "changed", oldValue: 1, newValue: 2 }]);
    expect(computeDiff({ a: 1 }, "x")).toEqual([{ path: "(root)", type: "changed", oldValue: { a: 1 }, newValue: "x" }]);
  });

  it("prefixes paths with a caller-given base path", () => {
    expect(computeDiff({ a: 1 }, { a: 2 }, "state")).toEqual([
      { path: "state.a", type: "changed", oldValue: 1, newValue: 2 },
    ]);
  });
});

describe("computeDiff: arrays compared by index", () => {
  it("diffs object items in place and reports growth as added", () => {
    expect(computeDiff([{ a: 1 }], [{ a: 2 }, { b: 2 }])).toEqual([
      { path: "[0].a", type: "changed", oldValue: 1, newValue: 2 },
      { path: "[1]", type: "added", newValue: { b: 2 } },
    ]);
  });

  it("reports shrinkage of object arrays as removed", () => {
    expect(computeDiff({ xs: [{ a: 1 }, { b: 2 }] }, { xs: [{ a: 1 }] })).toEqual([
      { path: "xs[1]", type: "removed", oldValue: { b: 2 } },
    ]);
  });

  it("does not align arrays that mix objects with primitives", () => {
    expect(computeDiff([{ a: 1 }, 1], [1])).toEqual([
      { path: "[0]", type: "changed", oldValue: { a: 1 }, newValue: 1 },
      { path: "[1]", type: "removed", oldValue: 1 },
    ]);
    expect(computeDiff([1], [{ a: 1 }, 1])).toEqual([
      { path: "[0]", type: "changed", oldValue: 1, newValue: { a: 1 } },
      { path: "[1]", type: "added", newValue: 1 },
    ]);
  });
});

describe("computeDiff: primitive arrays are aligned", () => {
  it.each<[string, unknown[], unknown[], DiffEntry[]]>([
    ["booleans", [true, false], [false], [{ path: "[0]", type: "removed", oldValue: true }]],
    ["nulls", [null, 1], [1], [{ path: "[0]", type: "removed", oldValue: null }]],
    ["numbers", [1, 2, 3], [2, 3], [{ path: "[0]", type: "removed", oldValue: 1 }]],
    ["strings", ["x"], ["w", "x"], [{ path: "[0]", type: "added", newValue: "w" }]],
  ])("aligns arrays of %s", (_, before, after, expected) => {
    expect(computeDiff(before, after)).toEqual(expected);
  });

  it("keeps separate runs of changes apart", () => {
    expect(computeDiff(["a", "x", "b", "y", "c"], ["a", "X", "b", "c"])).toEqual([
      { path: "[1]", type: "changed", oldValue: "x", newValue: "X" },
      { path: "[3]", type: "removed", oldValue: "y" },
    ]);
  });

  it("uses the old index for removals and the new index for changes in the same run", () => {
    expect(computeDiff([0, "a", "b", 5], [0, "A", 5, 6, 7])).toEqual([
      { path: "[1]", type: "changed", oldValue: "a", newValue: "A" },
      { path: "[2]", type: "removed", oldValue: "b" },
      { path: "[3]", type: "added", newValue: 6 },
      { path: "[4]", type: "added", newValue: 7 },
    ]);
    expect(computeDiff([9, 1, 2, 3], [1, 7, 3])).toEqual([
      { path: "[0]", type: "removed", oldValue: 9 },
      { path: "[1]", type: "changed", oldValue: 2, newValue: 7 },
    ]);
  });

  it("pairs the k-th removal with the k-th addition when their indices differ", () => {
    expect(computeDiff(["k", "a", "b", "c", "z"], ["k", "z", "p", "q"])).toEqual([
      { path: "[1]", type: "removed", oldValue: "a" },
      { path: "[2]", type: "removed", oldValue: "b" },
      { path: "[3]", type: "removed", oldValue: "c" },
      { path: "[2]", type: "added", newValue: "p" },
      { path: "[3]", type: "added", newValue: "q" },
    ]);
  });

  it("prefers a removal when removing and adding keep the same number of matches", () => {
    expect(computeDiff([1, 2], [2, 1, 3])).toEqual([
      { path: "[0]", type: "removed", oldValue: 1 },
      { path: "[1]", type: "added", newValue: 1 },
      { path: "[2]", type: "added", newValue: 3 },
    ]);
  });

  it("does not let the common prefix and suffix overlap", () => {
    expect(computeDiff([1, 1], [1, 1, 1])).toEqual([{ path: "[2]", type: "added", newValue: 1 }]);
    expect(computeDiff([1, 1, 1], [1, 1])).toEqual([{ path: "[2]", type: "removed", oldValue: 1 }]);
    expect(computeDiff(["a", "b", "a"], ["a", "b", "a", "b", "a"])).toEqual([
      { path: "[3]", type: "added", newValue: "b" },
      { path: "[4]", type: "added", newValue: "a" },
    ]);
  });

  it("aligns using the full middle, matching items near both ends", () => {
    expect(computeDiff(["s", 1, 2, 3, "e"], ["s", 2, 3, 1, 9, "e"])).toEqual([
      { path: "[1]", type: "removed", oldValue: 1 },
      { path: "[3]", type: "added", newValue: 1 },
      { path: "[4]", type: "added", newValue: 9 },
    ]);
  });

  // A seeded generator so the comparison covers many shapes deterministically.
  function rng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
      return s / 2_147_483_648;
    };
  }

  it("agrees with a reference LCS alignment on many small arrays", () => {
    const next = rng(42);
    const pick = (n: number) => Math.floor(next() * n);
    const alphabet = ["a", "b", "c", 1, 2, true, null];
    for (let round = 0; round < 400; round++) {
      const before = Array.from({ length: pick(7) }, () => alphabet[pick(alphabet.length)]);
      let after = Array.from({ length: pick(7) }, () => alphabet[pick(alphabet.length)]);
      if (after.length === before.length) after = [...after, "tail"];
      expectMinimalAlignment(before, after, computeDiff(before, after));
    }
  });

  it("aligns at exactly the cell limit and falls back to the index diff just above it", () => {
    const unique = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    const atLimit = { before: ["k", ...unique("b", 399)], after: [...unique("a", 624), "k"] };
    const aligned = computeDiff(atLimit.before, atLimit.after);
    expect(aligned).toHaveLength(624 + 399);
    expect(aligned.some((d) => d.type === "changed")).toBe(false);

    const aboveLimit = { before: ["k", ...unique("b", 400)], after: [...unique("a", 624), "k"] };
    const byIndex = computeDiff(aboveLimit.before, aboveLimit.after);
    expect(byIndex).toHaveLength(625);
    expect(byIndex[0]).toEqual({ path: "[0]", type: "changed", oldValue: "k", newValue: "a0" });
  });
});

function lcsLength(before: unknown[], after: unknown[]): number {
  let prev = Array.from({ length: after.length + 1 }, () => 0);
  for (const x of before) {
    const row = [0];
    after.forEach((y, j) => {
      row.push(x === y ? (prev[j] ?? 0) + 1 : Math.max(prev[j + 1] ?? 0, row[j] ?? 0));
    });
    prev = row;
  }
  return prev[after.length] ?? 0;
}

function indexOf(path: string): number {
  const match = /^\[(\d+)\]$/.exec(path);
  if (match === null) throw new Error(`not an index path: ${path}`);
  return Number(match[1]);
}

/**
 * The aligned diff must be minimal (unchanged items = the LCS), carry the
 * right values at each index, and the untouched items must line up in order.
 */
function expectMinimalAlignment(before: unknown[], after: unknown[], diffs: DiffEntry[]): void {
  const context = JSON.stringify([before, after]);
  const lcs = lcsLength(before, after);
  const count = (type: DiffEntry["type"]) => diffs.filter((d) => d.type === type).length;
  expect(count("removed") + count("changed"), context).toBe(before.length - lcs);
  expect(count("added") + count("changed"), context).toBe(after.length - lcs);
  const touchedAfter = new Set<number>();
  const removedBefore = new Set<number>();
  for (const d of diffs) {
    const i = indexOf(d.path);
    if (d.type === "removed") {
      expect(d.oldValue, context).toBe(before[i]);
      removedBefore.add(i);
    } else {
      expect(d.newValue, context).toBe(after[i]);
      touchedAfter.add(i);
    }
  }
  const keptAfter = after.filter((_, j) => !touchedAfter.has(j));
  const keptBefore = before.filter((_, i) => !removedBefore.has(i));
  let k = 0;
  for (const item of keptBefore) if (item === keptAfter[k]) k++;
  expect(k, context).toBe(keptAfter.length);
}

function diffRows(before: unknown, after: unknown) {
  const { container } = render(createElement(JsonDiff, { before, after }));
  return { container, rows: [...container.querySelectorAll("[data-diff-row]")] };
}

describe("JsonDiff rendering", () => {
  it("says No changes for equal values", () => {
    const { container, rows } = diffRows({ a: 1 }, { a: 1 });
    expect(rows).toHaveLength(0);
    expect(container.textContent).toBe("No changes");
  });

  it("renders each row type with its marker and values", () => {
    const { rows } = diffRows({ gone: "x", n: 1 }, { n: 2, added: [1] });
    expect(rows.map((r) => [r.getAttribute("data-diff-type"), r.textContent])).toEqual([
      ["removed", 'gone-"x"'],
      ["changed", "n1→2"],
      ["added", "added+[1]"],
    ]);
  });

  it("formats strings raw in quotes, objects as JSON, and undefined by name", () => {
    expect(diffRows("say \"hi\"\n", null).rows[0]?.textContent).toBe('(root)"say "hi"\n"→null');
    expect(diffRows(undefined, { a: [true] }).rows[0]?.textContent).toBe('(root)undefined→{"a":[true]}');
    expect(diffRows(false, 0).rows[0]?.textContent).toBe("(root)false→0");
  });

  it("keeps a value of exactly the preview length whole and truncates a longer one", () => {
    const exact = "x".repeat(DIFF_VALUE_PREVIEW_LENGTH - 2); // plus two quotes
    expect(diffRows(1, exact).rows[0]?.textContent).toBe(`(root)1→"${exact}"`);
    const longer = `${exact}y`;
    expect(diffRows(1, longer).rows[0]?.textContent).toBe(`(root)1→"${exact}y…`);
  });

  it("shows exactly the row cap without a summary", () => {
    const before = Object.fromEntries(Array.from({ length: MAX_DIFF_ROWS }, (_, i) => [`k${i}`, i]));
    const after = Object.fromEntries(Array.from({ length: MAX_DIFF_ROWS }, (_, i) => [`k${i}`, i + 1]));
    const { container, rows } = diffRows(before, after);
    expect(rows).toHaveLength(MAX_DIFF_ROWS);
    expect(container.textContent).not.toContain("more changes");
  });

  it("summarizes rows beyond the cap", () => {
    const before = Object.fromEntries(Array.from({ length: MAX_DIFF_ROWS + 3 }, (_, i) => [`k${i}`, i]));
    const { container, rows } = diffRows(before, {});
    expect(rows).toHaveLength(MAX_DIFF_ROWS);
    expect(container.textContent).toContain("…and 3 more changes");
  });
});
