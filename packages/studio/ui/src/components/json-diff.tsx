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
        <div key={i} className="flex gap-2 items-baseline min-w-0 break-all" data-diff-row>
          <span className="text-violet-400 shrink-0">{diff.path}</span>
          {diff.type === "added" && (
            <>
              <span className="text-emerald-500">+</span>
              <span className="text-emerald-400">{formatValue(diff.newValue)}</span>
            </>
          )}
          {diff.type === "removed" && (
            <>
              <span className="text-red-500">-</span>
              <span className="text-red-400 line-through">{formatValue(diff.oldValue)}</span>
            </>
          )}
          {diff.type === "changed" && (
            <>
              <span className="text-red-400 line-through">{formatValue(diff.oldValue)}</span>
              <span className="text-zinc-600">&rarr;</span>
              <span className="text-emerald-400">{formatValue(diff.newValue)}</span>
            </>
          )}
        </div>
      ))}
      {hidden > 0 && <p className="text-zinc-500">…and {hidden} more changes</p>}
    </div>
  );
}
