export function CounterDisplay({
  count,
  lastUpdatedBy,
  onIncrement,
  onDecrement,
  disabled,
}: {
  count: number;
  lastUpdatedBy: string | null;
  onIncrement: () => void;
  onDecrement: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex w-full flex-col items-center gap-6">
      <div
        id="count"
        className="text-7xl font-bold tabular-nums text-[var(--sea-ink)]"
      >
        {count}
      </div>
      {lastUpdatedBy ? (
        <p id="last-updated" className="text-sm text-[var(--sea-ink-soft)]">
          Last updated by: {lastUpdatedBy}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button
          id="decrement"
          className="rounded-2xl border border-gray-200 px-6 py-3 text-xl font-medium transition hover:-translate-y-0.5 hover:bg-gray-50 disabled:opacity-50"
          disabled={disabled}
          onClick={onDecrement}
          type="button"
        >
          &minus;
        </button>
        <button
          id="increment"
          className="rounded-2xl border border-[rgba(26,138,122,0.3)] bg-[rgba(26,138,122,0.1)] px-6 py-3 text-xl font-medium text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[rgba(26,138,122,0.2)] disabled:opacity-50"
          disabled={disabled}
          onClick={onIncrement}
          type="button"
        >
          +
        </button>
      </div>
    </div>
  );
}
