/**
 * Compute and display a JSON diff between two values.
 * Shows added (green), removed (red), and changed (yellow) fields.
 */

interface DiffEntry {
  path: string;
  type: "added" | "removed" | "changed";
  oldValue?: unknown;
  newValue?: unknown;
}

function computeDiff(before: unknown, after: unknown, path = ""): DiffEntry[] {
  const diffs: DiffEntry[] = [];

  if (before === after) return diffs;

  // Both are objects
  if (
    typeof before === "object" &&
    before !== null &&
    !Array.isArray(before) &&
    typeof after === "object" &&
    after !== null &&
    !Array.isArray(after)
  ) {
    const beforeObj = before as Record<string, unknown>;
    const afterObj = after as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);

    for (const key of allKeys) {
      const fieldPath = path ? `${path}.${key}` : key;
      if (!(key in beforeObj)) {
        diffs.push({ path: fieldPath, type: "added", newValue: afterObj[key] });
      } else if (!(key in afterObj)) {
        diffs.push({ path: fieldPath, type: "removed", oldValue: beforeObj[key] });
      } else {
        diffs.push(...computeDiff(beforeObj[key], afterObj[key], fieldPath));
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

  // Primitive change
  diffs.push({ path: path || "(root)", type: "changed", oldValue: before, newValue: after });
  return diffs;
}

function formatValue(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (typeof val === "string") return `"${val}"`;
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
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

  return (
    <div className="space-y-0.5">
      {diffs.map((diff, i) => (
        <div key={i} className="flex gap-2 items-baseline">
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
    </div>
  );
}
