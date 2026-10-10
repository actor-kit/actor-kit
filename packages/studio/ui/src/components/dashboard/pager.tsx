import { TAP } from "../phone";

const BUTTON_CLASS = `px-2 py-1 rounded bg-zinc-800 disabled:opacity-40 cursor-pointer disabled:cursor-default ${TAP}`;

interface PagerProps {
  offset: number;
  /** Rows on this page. */
  shown: number;
  hasMore: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

/** Previous/Next with the 1-based row range of the current page. */
export function Pager({ offset, shown, hasMore, onPrevious, onNext }: PagerProps) {
  return (
    <div className="flex items-center gap-3 mt-3 text-sm text-zinc-400">
      <button
        type="button"
        disabled={offset === 0}
        onClick={onPrevious}
        className={BUTTON_CLASS}
        data-testid="page-prev"
      >
        Previous
      </button>
      <span data-testid="page-info">
        {offset + 1}–{offset + shown}
      </span>
      <button type="button" disabled={!hasMore} onClick={onNext} className={BUTTON_CLASS} data-testid="page-next">
        Next
      </button>
    </div>
  );
}
