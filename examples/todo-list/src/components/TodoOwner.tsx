import { useState } from "react";

export function TodoOwner({
  todos,
  memberCount,
  canDelete,
  role,
  onAdd,
  onToggle,
  onDelete,
}: {
  todos: { id: string; text: string; done: boolean }[];
  memberCount: number;
  canDelete: boolean;
  role: string;
  onAdd: (text: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [text, setText] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed) {
      onAdd(trimmed);
      setText("");
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div id="role-info" className="text-sm text-[var(--sea-ink-soft)]">
        Role: {role} &middot; {memberCount} member{memberCount !== 1 ? "s" : ""}
      </div>

      <form id="add-form" className="flex gap-2" onSubmit={handleSubmit}>
        <input
          id="todo-input"
          type="text"
          className="flex-1 rounded-xl border border-gray-200 px-4 py-2 text-sm focus:border-[var(--lagoon-deep)] focus:outline-none"
          placeholder="Add a todo..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={200}
        />
        <button
          id="add-btn"
          type="submit"
          className="rounded-xl border border-[rgba(26,138,122,0.3)] bg-[rgba(26,138,122,0.1)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(26,138,122,0.2)]"
        >
          Add
        </button>
      </form>

      <div id="todos" className="flex flex-col gap-1">
        {todos.length === 0 ? (
          <p className="py-4 text-center text-sm text-[var(--sea-ink-soft)]">
            No todos yet. Add one above.
          </p>
        ) : (
          todos.map((todo) => (
            <div
              key={todo.id}
              className={`todo flex items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-gray-50${todo.done ? " done" : ""}`}
            >
              <input
                type="checkbox"
                checked={todo.done}
                onChange={() => onToggle(todo.id)}
                className="h-4 w-4 cursor-pointer accent-[var(--lagoon-deep)]"
              />
              <span
                className={`flex-1 text-sm ${todo.done ? "text-[var(--sea-ink-soft)] line-through" : "text-[var(--sea-ink)]"}`}
              >
                {todo.text}
              </span>
              {canDelete ? (
                <button
                  type="button"
                  className="text-lg text-gray-400 transition hover:text-red-500"
                  onClick={() => onDelete(todo.id)}
                  title="Delete"
                >
                  &times;
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
