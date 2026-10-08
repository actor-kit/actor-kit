/**
 * @vitest-environment jsdom
 *
 * JsonTree: scalar rendering, collapse/expand at depth, paging of large
 * collections, separators, and long-string truncation.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CHILD_PAGE_SIZE, JsonTree, STRING_PREVIEW_LENGTH } from "../../packages/studio/ui/src/components/json-tree";

afterEach(cleanup);

function tree(data: unknown) {
  return render(createElement(JsonTree, { data })).container;
}

describe("JsonTree scalars", () => {
  it.each<[unknown, string]>([
    [null, "null"],
    [undefined, "undefined"],
    [0, "0"],
    [-1.5, "-1.5"],
    [true, "true"],
    [false, "false"],
    ["", '""'],
    ["hi", '"hi"'],
  ])("renders %j as %s with no controls", (value, text) => {
    const container = tree(value);
    expect(container.textContent).toBe(text);
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders empty collections as bare brackets with no controls", () => {
    const container = tree({ a: [], b: {} });
    expect(container.textContent).toBe("{a:[]b:{}}");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

describe("JsonTree collections", () => {
  it("separates array items with commas, not after the last", () => {
    expect(tree([1, "a", null]).textContent).toBe('[1,"a",null]');
  });

  it("opens the first two levels and collapses deeper objects and arrays", () => {
    expect(tree({ a: { b: { c: 1 } } }).textContent).toBe("{a:{b:{ 1 keys }}}");
    cleanup();
    expect(tree([[[1, 2]]]).textContent).toBe("[[[2 items]]]");
  });

  it("marks toggles with their expanded state, and collapses and re-opens on click", () => {
    const container = tree({ a: [1, 2], b: 1 });
    const [rootToggle, arrayToggle] = screen.getAllByRole("button");
    expect(rootToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(arrayToggle?.getAttribute("aria-expanded")).toBe("true");
    if (arrayToggle === undefined) throw new Error("missing toggle");
    fireEvent.click(arrayToggle);
    expect(container.textContent).toBe("{a:[2 items]b:1}");
    const collapsed = screen.getByRole("button", { name: "[2 items]" });
    expect(collapsed.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(collapsed);
    expect(container.textContent).toBe("{a:[1,2]b:1}");
    fireEvent.click(screen.getAllByRole("button")[0] ?? collapsed);
    expect(container.textContent).toBe("{ 2 keys }");
  });

  it("pages large arrays and says how many are left", () => {
    const items = Array.from({ length: CHILD_PAGE_SIZE + 50 }, (_, i) => i);
    const container = tree(items);
    expect(container.textContent).toContain(`${CHILD_PAGE_SIZE - 1},`);
    expect(container.textContent).not.toContain(`${CHILD_PAGE_SIZE},`);
    const more = screen.getByRole("button", { name: "show 50 more (50 hidden)" });
    fireEvent.click(more);
    expect(container.textContent).toBe(`[${items.join(",")}]`);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  it("pages large objects and offers a full page when many are hidden", () => {
    const record = Object.fromEntries(Array.from({ length: CHILD_PAGE_SIZE * 2 + 1 }, (_, i) => [`k${i}`, i]));
    const container = tree(record);
    expect(container.textContent).toContain(`k${CHILD_PAGE_SIZE - 1}:`);
    expect(container.textContent).not.toContain(`k${CHILD_PAGE_SIZE}:`);
    fireEvent.click(screen.getByRole("button", { name: `show ${CHILD_PAGE_SIZE} more (${CHILD_PAGE_SIZE + 1} hidden)` }));
    expect(container.textContent).toContain(`k${CHILD_PAGE_SIZE * 2 - 1}:`);
    expect(container.textContent).not.toContain(`k${CHILD_PAGE_SIZE * 2}:`);
    fireEvent.click(screen.getByRole("button", { name: "show 1 more (1 hidden)" }));
    expect(container.textContent).toContain(`k${CHILD_PAGE_SIZE * 2}:`);
  });

  it("shows no paging control for exactly one page", () => {
    tree(Array.from({ length: CHILD_PAGE_SIZE }, (_, i) => i));
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
    cleanup();
    tree(Object.fromEntries(Array.from({ length: CHILD_PAGE_SIZE }, (_, i) => [`k${i}`, i])));
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });
});

describe("JsonTree strings", () => {
  it("shows a string of exactly the preview length whole", () => {
    const value = "x".repeat(STRING_PREVIEW_LENGTH);
    expect(tree(value).textContent).toBe(`"${value}"`);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("truncates a longer string with an ellipsis until expanded", () => {
    const value = `${"x".repeat(STRING_PREVIEW_LENGTH)}TAIL`;
    const container = tree(value);
    expect(container.textContent).toBe(`"${"x".repeat(STRING_PREVIEW_LENGTH)}…"show all ${value.length} characters`);
    fireEvent.click(screen.getByRole("button", { name: `show all ${value.length} characters` }));
    expect(container.textContent).toBe(`"${value}"`);
  });
});
