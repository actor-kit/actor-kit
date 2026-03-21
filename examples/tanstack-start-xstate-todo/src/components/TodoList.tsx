"use client";

import { Link } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";
import { TodoActorKitContext } from "../todo.context";

export function TodoList({ userId }: { userId: string }) {
  const todos = TodoActorKitContext.useSelector((state) => state.todos);
  const ownerId = TodoActorKitContext.useSelector((state) => state.ownerId);
  const send = TodoActorKitContext.useSend();
  const [text, setText] = useState("");
  const isHydrated = useHydrated();
  const isOwner = ownerId === userId;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="island-kicker mb-2">Shared List</p>
          <h1 className="text-3xl font-semibold text-[var(--sea-ink)]">
            Todo List
          </h1>
        </div>
        <Link to="/" className="text-sm font-medium text-[var(--lagoon-deep)]">
          Home
        </Link>
      </div>

      {isOwner ? (
        <form
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            const nextText = text.trim();
            if (!nextText) {
              return;
            }
            send({ type: "ADD_TODO", text: nextText });
            setText("");
          }}
        >
          <input
            className="todo-input min-w-0 flex-1 rounded-2xl px-4 py-3 text-base outline-none transition"
            disabled={!isHydrated}
            onChange={(event) => setText(event.target.value)}
            placeholder="Add a new todo"
            type="text"
            value={text}
          />
          <button
            className="todo-primary-button rounded-2xl px-5 py-3 text-sm font-semibold transition hover:-translate-y-0.5"
            disabled={!isHydrated}
            type="submit"
          >
            Add
          </button>
        </form>
      ) : null}

      <ul className="flex flex-col gap-3">
        {todos.map((todo) => (
          <li
            key={todo.id}
            className="todo-item flex flex-col gap-3 rounded-2xl px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <span
              className="text-base text-[var(--sea-ink)]"
              style={{
                textDecoration: todo.completed ? "line-through" : "none",
              }}
            >
              {todo.text}
            </span>
            {isOwner ? (
              <div className="flex gap-2">
                <button
                  className="todo-secondary-button rounded-full px-3 py-1.5 text-sm font-medium"
                  disabled={!isHydrated}
                  onClick={() => send({ type: "TOGGLE_TODO", id: todo.id })}
                  type="button"
                >
                  {todo.completed ? "Undo" : "Complete"}
                </button>
                <button
                  className="todo-danger-button rounded-full px-3 py-1.5 text-sm font-medium"
                  disabled={!isHydrated}
                  onClick={() => send({ type: "DELETE_TODO", id: todo.id })}
                  type="button"
                >
                  Delete
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function useHydrated() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}
