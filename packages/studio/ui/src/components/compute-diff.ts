/** Structural diff between two JSON values, as a flat list of path-addressed rows. */
import { isPlainRecord } from "./json-value";

export interface DiffEntry {
  path: string;
  type: "added" | "removed" | "changed";
  oldValue?: unknown;
  newValue?: unknown;
}

type Primitive = string | number | boolean | null;

function isPrimitive(value: unknown): value is Primitive {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Append an object key to a path; keys that aren't plain identifiers use bracket notation. */
function keyPath(path: string, key: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return path ? `${path}.${key}` : key;
  return `${path}[${JSON.stringify(key)}]`;
}

export function computeDiff(before: unknown, after: unknown, path = ""): DiffEntry[] {
  return diffAt(before, after, path);
}

function diffAt(before: unknown, after: unknown, path: string): DiffEntry[] {
  if (before === after) return [];
  if (isPlainRecord(before) && isPlainRecord(after)) return diffRecords(before, after, path);
  if (Array.isArray(before) && Array.isArray(after)) return diffArrays(before, after, path);
  // Primitive change (or a change of kind, e.g. array → object)
  return [{ path: path || "(root)", type: "changed", oldValue: before, newValue: after }];
}

function diffRecords(before: Record<string, unknown>, after: Record<string, unknown>, path: string): DiffEntry[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap((key) => diffField(before, after, key, keyPath(path, key)));
}

/** Own keys only: a key named `toString` is data, not the inherited method. */
function diffField(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  key: string,
  path: string,
): DiffEntry[] {
  if (!Object.hasOwn(before, key)) return [{ path, type: "added", newValue: after[key] }];
  if (!Object.hasOwn(after, key)) return [{ path, type: "removed", oldValue: before[key] }];
  return diffAt(before[key], after[key], path);
}

function diffArrays(before: unknown[], after: unknown[], path: string): DiffEntry[] {
  if (before.length !== after.length && before.every(isPrimitive) && after.every(isPrimitive)) {
    const aligned = alignPrimitiveArrays(before, after, path);
    if (aligned !== null) return aligned;
  }
  return diffByIndex(before, after, path);
}

function diffByIndex(before: unknown[], after: unknown[], path: string): DiffEntry[] {
  const length = Math.max(before.length, after.length);
  return Array.from({ length }, (_, i) => diffSlot(before, after, i, `${path}[${i}]`)).flat();
}

function diffSlot(before: unknown[], after: unknown[], i: number, path: string): DiffEntry[] {
  if (i >= before.length) return [{ path, type: "added", newValue: after[i] }];
  if (i >= after.length) return [{ path, type: "removed", oldValue: before[i] }];
  return diffAt(before[i], after[i], path);
}

// --- Aligned diff for primitive arrays ---

/** Above this many LCS cells (after trimming the common prefix/suffix) arrays fall back to the index diff. */
const MAX_ALIGN_CELLS = 250_000;

type EditOp = "keep" | "remove" | "add";

/** How far each edit advances through [before, after]. */
const EDIT_STEP: Readonly<Record<EditOp, readonly [number, number]>> = {
  keep: [1, 1],
  remove: [1, 0],
  add: [0, 1],
};

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
  const start = commonPrefix(before, after);
  const end = commonSuffix(before, after, start);
  const middleBefore = before.slice(start, before.length - end);
  const middleAfter = after.slice(start, after.length - end);
  if (middleBefore.length * middleAfter.length > MAX_ALIGN_CELLS) return null;
  return applyEdits(editScript(middleBefore, middleAfter), before, after, start, path);
}

function commonPrefix(a: readonly Primitive[], b: readonly Primitive[]): number {
  const limit = Math.min(a.length, b.length);
  let n = 0;
  while (n < limit && a[n] === b[n]) n++;
  return n;
}

/** Matching items at the end, not reaching back into the first `prefix` items. */
function commonSuffix(a: readonly Primitive[], b: readonly Primitive[], prefix: number): number {
  const limit = Math.min(a.length, b.length) - prefix;
  let n = 0;
  while (n < limit && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** lcs(i, j) = LCS length of a[i..] and b[j..]. */
function lcsTable(a: readonly Primitive[], b: readonly Primitive[]): (i: number, j: number) => number {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  const lcs = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }
  return lcs;
}

/** The shortest edit from a to b, front to back; ties prefer removing. */
function editScript(a: readonly Primitive[], b: readonly Primitive[]): EditOp[] {
  const lcs = lcsTable(a, b);
  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const op = nextEdit(a, b, i, j, lcs);
    ops.push(op);
    const [di, dj] = EDIT_STEP[op];
    i += di;
    j += dj;
  }
  return ops;
}

function nextEdit(
  a: readonly Primitive[],
  b: readonly Primitive[],
  i: number,
  j: number,
  lcs: (i: number, j: number) => number,
): EditOp {
  if (i >= a.length) return "add";
  if (j >= b.length) return "remove";
  if (a[i] === b[j]) return "keep";
  return lcs(i + 1, j) >= lcs(i, j + 1) ? "remove" : "add";
}

/** Turn an edit script over the middles (starting at `start`) into diff rows, run by run. */
function applyEdits(
  ops: readonly EditOp[],
  before: readonly Primitive[],
  after: readonly Primitive[],
  start: number,
  path: string,
): DiffEntry[] {
  const diffs: DiffEntry[] = [];
  let run: Run = { removed: [], added: [] };
  let i = start;
  let j = start;
  for (const op of ops) {
    if (op === "keep") {
      diffs.push(...runRows(run, before, after, path));
      run = { removed: [], added: [] };
      i++;
      j++;
    } else if (op === "remove") {
      run.removed.push(i++);
    } else {
      run.added.push(j++);
    }
  }
  diffs.push(...runRows(run, before, after, path));
  return diffs;
}

/** Indices of one run of unmatched items: removals in `before`, additions in `after`. */
interface Run {
  removed: number[];
  added: number[];
}

/** Pair the k-th removal with the k-th addition as a change; the rest stay removals or additions. */
function runRows(run: Run, before: readonly Primitive[], after: readonly Primitive[], path: string): DiffEntry[] {
  const paired = Math.min(run.removed.length, run.added.length);
  const changed = run.added.slice(0, paired).map(
    (a, k): DiffEntry => ({
      path: `${path}[${a}]`,
      type: "changed",
      oldValue: before[run.removed[k] ?? a],
      newValue: after[a],
    }),
  );
  const removed = run.removed
    .slice(paired)
    .map((r): DiffEntry => ({ path: `${path}[${r}]`, type: "removed", oldValue: before[r] }));
  const added = run.added
    .slice(paired)
    .map((a): DiffEntry => ({ path: `${path}[${a}]`, type: "added", newValue: after[a] }));
  return [...changed, ...removed, ...added];
}
