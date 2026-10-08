import { useState } from "react";
import { isPlainRecord } from "./json-value";

/** Children rendered per page for large arrays/objects. */
export const CHILD_PAGE_SIZE = 100;
/** Strings longer than this are truncated until expanded. */
export const STRING_PREVIEW_LENGTH = 200;

interface JsonTreeProps {
  data: unknown;
  level?: number;
}

export function JsonTree({ data, level = 0 }: JsonTreeProps) {
  if (data === null) return <span className="text-zinc-500">null</span>;
  if (data === undefined) return <span className="text-zinc-500">undefined</span>;
  if (typeof data === "string") return <JsonString value={data} />;
  if (typeof data === "number") return <span className="text-amber-400">{data}</span>;
  if (typeof data === "boolean") return <span className="text-sky-400">{String(data)}</span>;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-zinc-500">[]</span>;
    return <CollapsibleArray data={data} level={level} />;
  }

  if (isPlainRecord(data)) {
    const entries = Object.entries(data);
    if (entries.length === 0) return <span className="text-zinc-500">{"{}"}</span>;
    return <CollapsibleObject entries={entries} level={level} />;
  }

  return <span>{String(data)}</span>;
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
        >
          show all {value.length} characters
        </button>
      )}
    </span>
  );
}

function ShowMore({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer">
      show {Math.min(hidden, CHILD_PAGE_SIZE)} more ({hidden} hidden)
    </button>
  );
}

function CollapsibleObject({ entries, level }: { entries: [string, unknown][]; level: number }) {
  const [open, setOpen] = useState(level < 2);
  const [visible, setVisible] = useState(CHILD_PAGE_SIZE);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
        {"{"} {entries.length} keys {"}"}
      </button>
    );
  }

  const hidden = entries.length - visible;
  return (
    <div>
      <button type="button" onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
        {"{"}
      </button>
      <div className="pl-4 border-l border-zinc-800">
        {entries.slice(0, visible).map(([key, val]) => (
          <div key={key} className="flex gap-1 min-w-0">
            <span className="text-violet-400 shrink-0">{key}</span>
            <span className="text-zinc-600">:</span>
            <JsonTree data={val} level={level + 1} />
          </div>
        ))}
        {hidden > 0 && <ShowMore hidden={hidden} onClick={() => setVisible((v) => v + CHILD_PAGE_SIZE)} />}
      </div>
      <span className="text-zinc-500">{"}"}</span>
    </div>
  );
}

function CollapsibleArray({ data, level }: { data: unknown[]; level: number }) {
  const [open, setOpen] = useState(level < 2);
  const [visible, setVisible] = useState(CHILD_PAGE_SIZE);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
        [{data.length} items]
      </button>
    );
  }

  const hidden = data.length - visible;
  return (
    <div>
      <button type="button" onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
        [
      </button>
      <div className="pl-4 border-l border-zinc-800">
        {data.slice(0, visible).map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: JSON array items have no identity besides their position
          <div key={i}>
            <JsonTree data={item} level={level + 1} />
            {i < data.length - 1 && <span className="text-zinc-600">,</span>}
          </div>
        ))}
        {hidden > 0 && <ShowMore hidden={hidden} onClick={() => setVisible((v) => v + CHILD_PAGE_SIZE)} />}
      </div>
      <span className="text-zinc-500">]</span>
    </div>
  );
}
