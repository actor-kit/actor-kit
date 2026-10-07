/**
 * Compute and display a JSON diff between two values.
 * Shows added (green), removed (red), and changed (yellow) fields.
 */
import { isPlainRecord } from "./json-value";

/** Rows rendered before the rest of a diff is summarized. */
export const MAX_DIFF_ROWS = 200;
/** Values longer than this (as text) are truncated in diff rows. */
export const DIFF_VALUE_PREVIEW_LENGTH = 200;

export interface DiffEntry {
  path: string;
  type: "added" | "removed" | "changed";
  oldValue?: unknown;
  newValue?: unknown;
}

/** Append an object key to a path; keys that aren't plain identifiers use bracket notation. */
function keyPath(path: string, key: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return path ? `${path}.${key}` : key;
  return `${path}[${JSON.stringify(key)}]`;
}

type Primitive = string | number | boolean | null;

function isPrimitive(value: unknown): value is Primitive {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Above this many LCS cells (after trimming the common prefix/suffix) arrays fall back to the index diff. */
const MAX_ALIGN_CELLS = 250_000;

/**
 * Diff two primitive arrays of different lengths by aligning them on their
 * longest common subsequence, so removing "bob" from [alice, bob, carol] is one
 * removed row rather than "bob → carol" plus "carol removed". Within each run
 * of unmatched items, removals and additions are paired up as changes.
 * Removed paths use the old index; added and changed paths use the new index.
 * Returns null when the unmatched middle is too large to align cheaply.
 */
function alignPrimitiveArrays(
  before: readonly Primitive[],
  after: readonly Primitive[],
  path: string,
): DiffEntry[] | null {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const rows = endBefore - start;
  const cols = endAfter - start;
  if (rows * cols > MAX_ALIGN_CELLS) return null;

  // lcs[i * (cols + 1) + j] = LCS length of before[start + i..endBefore) and after[start + j..endAfter)
  const lcs = new Uint32Array((rows + 1) * (cols + 1));
  const at = (i: number, j: number) => lcs[i * (cols + 1) + j] ?? 0;
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i * (cols + 1) + j] =
        before[start + i] === after[start + j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const diffs: DiffEntry[] = [];
  let removed: number[] = [];
  let added: number[] = [];
  const flush = () => {
    const paired = Math.min(removed.length, added.length);
    removed.slice(0, paired).forEach((r, k) => {
      const a = added[k] ?? r;
      diffs.push({ path: `${path}[${a}]`, type: "changed", oldValue: before[r], newValue: after[a] });
    });
    for (const r of removed.slice(paired)) diffs.push({ path: `${path}[${r}]`, type: "removed", oldValue: before[r] });
    for (const a of added.slice(paired)) diffs.push({ path: `${path}[${a}]`, type: "added", newValue: after[a] });
    removed = [];
    added = [];
  };

  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && before[start + i] === after[start + j]) {
      flush();
      i++;
      j++;
    } else if (j >= cols || (i < rows && at(i + 1, j) >= at(i, j + 1))) {
      removed.push(start + i);
      i++;
    } else {
      added.push(start + j);
      j++;
    }
  }
  flush();
  return diffs;
}

export function computeDiff(before: unknown, after: unknown, path = ""): DiffEntry[] {
  const diffs: DiffEntry[] = [];

  if (before === after) return diffs;

  // Both are objects
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const key of allKeys) {
      const fieldPath = keyPath(path, key);
      if (!(key in before)) {
        diffs.push({ path: fieldPath, type: "added", newValue: after[key] });
      } else if (!(key in after)) {
        diffs.push({ path: fieldPath, type: "removed", oldValue: before[key] });
      } else {
        diffs.push(...computeDiff(before[key], after[key], fieldPath));
      }
    }
    return diffs;
  }

  // Both are arrays
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length && before.every(isPrimitive) && after.every(isPrimitive)) {
      const aligned = alignPrimitiveArrays(before, after, path);
      if (aligned !== null) return aligned;
    }
    const maxLen = Math.max(before.length, after.length);
    for (let i = 0; i < maxLen; i++) {
      const fieldPath = `${path}[${i}]`;
      if (i >= before.length) {
        diffs.push({ path: fieldPath, type: "added", newValue: after[i] });
      } else if (i >= after.length) {
        diffs.push({ path: fieldPath, type: "removed", oldValue: before[i] });
      } else {
        diffs.push(...computeDiff(before[i], after[i], fieldPath));
      }
    }
    return diffs;
  }

  // Primitive change (or a change of kind, e.g. array → object)
  diffs.push({ path: path || "(root)", type: "changed", oldValue: before, newValue: after });
  return diffs;
}

function formatFull(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (typeof val === "string") return `"${val}"`;
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

function formatValue(val: unknown): string {
  const text = formatFull(val);
  return text.length > DIFF_VALUE_PREVIEW_LENGTH ? `${text.slice(0, DIFF_VALUE_PREVIEW_LENGTH)}…` : text;
}

interface JsonDiffProps {
  before: unknown;
  after: unknown;
}

export function JsonDiff({ before, after }: JsonDiffProps) {
  const diffs = computeDiff(before, after);

  if (diffs.length === 0) {
    return <span className="text-zinc-500">No changes</span>;
  }

  const hidden = diffs.length - MAX_DIFF_ROWS;
  return (
    <div className="space-y-0.5">
      {diffs.slice(0, MAX_DIFF_ROWS).map((diff, i) => (
        <div key={i} className="flex gap-2 items-baseline min-w-0 break-all" data-diff-row data-diff-type={diff.type}>
          <span className="text-violet-400 shrink-0">{diff.path}</span>
          {diff.type === "added" && (
            <>
              <span className="text-diff-added">+</span>
              <span className="text-diff-added">{formatValue(diff.newValue)}</span>
            </>
          )}
          {diff.type === "removed" && (
            <>
              <span className="text-diff-removed">-</span>
              <span className="text-diff-removed line-through">{formatValue(diff.oldValue)}</span>
            </>
          )}
          {diff.type === "changed" && (
            <>
              <span className="text-diff-changed/60 line-through">{formatValue(diff.oldValue)}</span>
              <span className="text-zinc-600">&rarr;</span>
              <span className="text-diff-changed">{formatValue(diff.newValue)}</span>
            </>
          )}
        </div>
      ))}
      {hidden > 0 && <p className="text-zinc-500">…and {hidden} more changes</p>}
    </div>
  );
}
