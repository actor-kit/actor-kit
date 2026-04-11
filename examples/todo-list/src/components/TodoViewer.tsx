export function TodoViewer({
  todoCount,
  doneCount,
  role,
}: {
  todoCount: number;
  doneCount: number;
  role: string;
}) {
  const pendingCount = todoCount - doneCount;

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div id="role-info" className="text-sm text-[var(--sea-ink-soft)]">
        Role: {role}
      </div>

      <div id="viewer-info" className="flex flex-col items-center gap-2 py-6">
        <div className="text-5xl font-bold tabular-nums text-[var(--sea-ink)]">
          {todoCount}
        </div>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          total todo{todoCount !== 1 ? "s" : ""}
        </p>

        <div className="mt-2 flex gap-6 text-sm">
          <div className="flex flex-col items-center">
            <span className="text-2xl font-semibold text-[var(--lagoon-deep)]">{doneCount}</span>
            <span className="text-[var(--sea-ink-soft)]">done</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-2xl font-semibold text-[var(--sea-ink)]">{pendingCount}</span>
            <span className="text-[var(--sea-ink-soft)]">pending</span>
          </div>
        </div>
      </div>

      <p className="text-center text-xs text-[var(--sea-ink-soft)]">
        You are a viewer. Only owners and members can manage todos.
      </p>
    </div>
  );
}
