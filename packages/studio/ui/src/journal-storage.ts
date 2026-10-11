/**
 * Where an actor's journal lives (ADR-019 D): archived segments in R2, the local rows, and the object's
 * storage against the per-object limit. Text for the actor header.
 */
import type { InspectResult } from "./protocol";

export type JournalStorage = NonNullable<InspectResult["journal"]>;

const UNITS = ["KB", "MB", "GB", "TB"];

/** Bytes as text: `1023 B`, `45.0 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

export function journalSummary(journal: JournalStorage): {
  archived: string | null;
  local: string;
  storage: string;
  warning: string | null;
} {
  const [first] = journal.archived;
  const segments = journal.archived.length === 1 ? "1 segment" : `${journal.archived.length} segments`;
  const percent = Math.floor((journal.storageBytes / journal.capBytes) * 100);
  const cap = formatBytes(journal.capBytes);
  return {
    archived:
      first === undefined
        ? null
        : `seq ${first.from}–${(journal.archived.at(-1) ?? first).to} archived in R2 (${segments}, ${formatBytes(journal.archivedBytes)})`,
    local:
      journal.local === null
        ? "no local events"
        : `seq ${journal.local.from}–${journal.local.to} local (${journal.local.events} events)`,
    storage: `storage ${formatBytes(journal.storageBytes)} of ${cap} (${percent}%)`,
    warning: journal.nearCap
      ? `Storage is at ${percent}% of the ${cap} per-object limit. Prune or archive the journal (journal: { keep, archive }).`
      : null,
  };
}
