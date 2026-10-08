/**
 * Display a JSON diff between two values.
 * Shows added (green), removed (red), and changed (yellow) fields.
 */
import { computeDiff, type DiffEntry } from "./compute-diff";

export { computeDiff, type DiffEntry } from "./compute-diff";

/** Rows rendered before the rest of a diff is summarized. */
export const MAX_DIFF_ROWS = 200;
/** Values longer than this (as text) are truncated in diff rows. */
export const DIFF_VALUE_PREVIEW_LENGTH = 200;

/** Strings are shown raw in quotes; everything else as JSON (undefined by name). */
function formatFull(val: unknown): string {
  if (typeof val === "string") return `"${val}"`;
  return val === undefined ? "undefined" : JSON.stringify(val);
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
      {diffs.slice(0, MAX_DIFF_ROWS).map((diff) => (
        <DiffRow key={`${diff.type}:${diff.path}`} diff={diff} />
      ))}
      {hidden > 0 && <p className="text-zinc-500">…and {hidden} more changes</p>}
    </div>
  );
}

function DiffRow({ diff }: { diff: DiffEntry }) {
  return (
    <div className="flex gap-2 items-baseline min-w-0 break-all" data-diff-row data-diff-type={diff.type}>
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
  );
}
