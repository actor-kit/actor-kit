"use client";

import { Link } from "@remix-run/react";
import React, { useState, useSyncExternalStore } from "react";
import { SessionContext } from "./session.context";
import { TodoContext } from "./todo.context";

export function TodoList() {
  const todos = TodoContext.useSelector((state) => state.public.todos);
  const send = TodoContext.useSend();
  const [newTodoText, setNewTodoText] = useState("");
  const isHydrated = useHydrated();

  const userId = SessionContext.useSelector((state) => state.public.userId);

  const ownerId = TodoContext.useSelector((state) => state.public.ownerId);
  const isOwner = ownerId === userId;

  const handleAddTodo = (e: React.FormEvent) => {
    e.preventDefault();
    if (newTodoText.trim()) {
      send({ type: "ADD_TODO", text: newTodoText.trim() });
      setNewTodoText("");
    }
  };

  return (
    <div>
      <Link to="/">⬅ Home</Link>
      <h1>Todo List</h1>

      {isOwner && (
        <form onSubmit={handleAddTodo}>
          <input
            disabled={!isHydrated}
            type="text"
            value={newTodoText}
            onChange={(e) => setNewTodoText(e.target.value)}
            placeholder="Add a new todo"
          />
          <button disabled={!isHydrated} type="submit">
            Add
          </button>
        </form>
      )}
      {isOwner && (
        <p>
          <em>
            Note: Try opening this page in incognito mode. You won&apos;t be
            able to make edits to this list since you won&apos;t be the owner,
            but you should see edits synced in real-time.
          </em>
        </p>
      )}
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <span
              style={{
                textDecoration: todo.completed ? "line-through" : "none",
              }}
            >
              {todo.text}
            </span>
            {isOwner && (
              <>
                <button
                  disabled={!isHydrated}
                  onClick={() => send({ type: "TOGGLE_TODO", id: todo.id })}
                >
                  {todo.completed ? "Undo" : "Complete"}
                </button>
                <button
                  disabled={!isHydrated}
                  onClick={() => send({ type: "DELETE_TODO", id: todo.id })}
                >
                  Delete
                </button>
              </>
            )}
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
