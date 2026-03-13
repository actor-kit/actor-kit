"use client";

import { Link } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";
import { TodoActorKitContext } from "../todo.context";

export function TodoList({ userId }: { userId: string }) {
  const todos = TodoActorKitContext.useSelector((state) => state.public.todos);
  const ownerId = TodoActorKitContext.useSelector((state) => state.public.ownerId);
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
            className="min-w-0 flex-1 rounded-2xl border border-[rgba(23,58,64,0.15)] bg-white px-4 py-3 text-base text-[var(--sea-ink)] outline-none transition focus:border-[rgba(50,143,151,0.55)]"
            disabled={!isHydrated}
            onChange={(event) => setText(event.target.value)}
            placeholder="Add a new todo"
            type="text"
            value={text}
          />
          <button
            className="rounded-2xl bg-[var(--lagoon-deep)] px-5 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5"
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
            className="flex flex-col gap-3 rounded-2xl border border-[rgba(23,58,64,0.12)] bg-white/80 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
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
                  className="rounded-full border border-[rgba(23,58,64,0.16)] px-3 py-1.5 text-sm font-medium text-[var(--sea-ink)]"
                  disabled={!isHydrated}
                  onClick={() => send({ type: "TOGGLE_TODO", id: todo.id })}
                  type="button"
                >
                  {todo.completed ? "Undo" : "Complete"}
                </button>
                <button
                  className="rounded-full border border-[rgba(181,89,70,0.2)] px-3 py-1.5 text-sm font-medium text-[rgb(143,63,47)]"
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
