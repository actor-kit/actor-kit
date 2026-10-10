import { type ReactNode, useState } from "react";
import { isPlainRecord } from "./json-value";

/** Children rendered per page for large arrays/objects. */
export const CHILD_PAGE_SIZE = 100;
/** Strings longer than this are truncated until expanded. */
export const STRING_PREVIEW_LENGTH = 200;

/** Colour per scalar type; null and undefined are muted. */
const SCALAR_CLASS: Readonly<Record<string, string>> = {
  number: "text-amber-400",
  boolean: "text-sky-400",
  undefined: "text-zinc-500",
};

const TOGGLE_CLASS = "text-zinc-500 hover:text-zinc-300 cursor-pointer";

interface JsonTreeProps {
  data: unknown;
  level?: number;
}

export function JsonTree({ data, level = 0 }: JsonTreeProps) {
  if (typeof data === "string") return <JsonString value={data} />;
  if (Array.isArray(data)) return <JsonArray items={data} level={level} />;
  if (isPlainRecord(data)) return <JsonObject entries={Object.entries(data)} level={level} />;
  return <span className={data === null ? "text-zinc-500" : SCALAR_CLASS[typeof data]}>{String(data)}</span>;
}

function JsonString({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = !expanded && value.length > STRING_PREVIEW_LENGTH;
  return (
    <span className="text-emerald-400 break-all">
      &quot;{truncated ? value.slice(0, STRING_PREVIEW_LENGTH) : value}
      {truncated && "…"}&quot;
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="ml-1 text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
          data-json-toggle
        >
          show all {value.length} characters
        </button>
      )}
    </span>
  );
}

function JsonObject({ entries, level }: { entries: [string, unknown][]; level: number }) {
  if (entries.length === 0) return <span className="text-zinc-500">{"{}"}</span>;
  return (
    <Collapsible level={level} size={entries.length} brackets={["{", "}"]} summary={`{ ${entries.length} keys }`}>
      {(visible) =>
        entries.slice(0, visible).map(([key, val]) => (
          <div key={key} className="flex gap-1 min-w-0">
            <span className="text-violet-400 shrink-0">{key}</span>
            <span className="text-zinc-600">:</span>
            <JsonTree data={val} level={level + 1} />
          </div>
        ))
      }
    </Collapsible>
  );
}

function JsonArray({ items, level }: { items: unknown[]; level: number }) {
  if (items.length === 0) return <span className="text-zinc-500">[]</span>;
  const last = items.length - 1;
  return (
    <Collapsible level={level} size={items.length} brackets={["[", "]"]} summary={`[${items.length} items]`}>
      {(visible) =>
        items.slice(0, visible).map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: JSON array items have no identity besides their position
          <div key={i}>
            <JsonTree data={item} level={level + 1} />
            {i < last && <span className="text-zinc-600">,</span>}
          </div>
        ))
      }
    </Collapsible>
  );
}

interface CollapsibleProps {
  level: number;
  /** Number of children, for paging. */
  size: number;
  brackets: readonly [open: string, close: string];
  /** Shown instead of the children while collapsed. */
  summary: string;
  children: (visible: number) => ReactNode;
}

/** Open for the first two levels; pages its children CHILD_PAGE_SIZE at a time. */
function Collapsible({ level, size, brackets, summary, children }: CollapsibleProps) {
  const [open, setOpen] = useState(level < 2);
  const [visible, setVisible] = useState(CHILD_PAGE_SIZE);

  if (!open) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className={TOGGLE_CLASS}
        data-json-toggle
      >
        {summary}
      </button>
    );
  }

  const hidden = size - visible;
  return (
    <div>
      <button
        type="button"
        aria-expanded={true}
        onClick={() => setOpen(false)}
        className={TOGGLE_CLASS}
        data-json-toggle
      >
        {brackets[0]}
      </button>
      <div className="pl-4 border-l border-zinc-800">
        {children(visible)}
        {hidden > 0 && <ShowMore hidden={hidden} onClick={() => setVisible((v) => v + CHILD_PAGE_SIZE)} />}
      </div>
      <span className="text-zinc-500">{brackets[1]}</span>
    </div>
  );
}

function ShowMore({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer">
      show {Math.min(hidden, CHILD_PAGE_SIZE)} more ({hidden} hidden)
    </button>
  );
}
