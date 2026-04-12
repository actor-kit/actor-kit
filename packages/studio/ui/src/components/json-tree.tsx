import { useState } from "react";

interface JsonTreeProps {
  data: unknown;
  level?: number;
}

export function JsonTree({ data, level = 0 }: JsonTreeProps) {
  if (data === null) return <span className="text-zinc-500">null</span>;
  if (data === undefined) return <span className="text-zinc-500">undefined</span>;
  if (typeof data === "string") return <span className="text-emerald-400">&quot;{data}&quot;</span>;
  if (typeof data === "number") return <span className="text-amber-400">{data}</span>;
  if (typeof data === "boolean") return <span className="text-sky-400">{String(data)}</span>;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-zinc-500">[]</span>;
    return <CollapsibleArray data={data} level={level} />;
  }

  if (typeof data === "object") {
    const entries = Object.entries(data);
    if (entries.length === 0) return <span className="text-zinc-500">{"{}"}</span>;
    return <CollapsibleObject entries={entries} level={level} />;
  }

  return <span>{String(data)}</span>;
}

function CollapsibleObject({ entries, level }: { entries: [string, unknown][]; level: number }) {
  const [open, setOpen] = useState(level < 2);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
        {"{"} {entries.length} keys {"}"}
      </button>
    );
  }

  return (
    <div>
      <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
        {"{"}
      </button>
      <div className="pl-4 border-l border-zinc-800">
        {entries.map(([key, val]) => (
          <div key={key} className="flex gap-1">
            <span className="text-violet-400">{key}</span>
            <span className="text-zinc-600">:</span>
            <JsonTree data={val} level={level + 1} />
          </div>
        ))}
      </div>
      <span className="text-zinc-500">{"}"}</span>
    </div>
  );
}

function CollapsibleArray({ data, level }: { data: unknown[]; level: number }) {
  const [open, setOpen] = useState(level < 2);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
        [{data.length} items]
      </button>
    );
  }

  return (
    <div>
      <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
        [
      </button>
      <div className="pl-4 border-l border-zinc-800">
        {data.map((item, i) => (
          <div key={i}>
            <JsonTree data={item} level={level + 1} />
            {i < data.length - 1 && <span className="text-zinc-600">,</span>}
          </div>
        ))}
      </div>
      <span className="text-zinc-500">]</span>
    </div>
  );
}
