"use client";

import type { CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTodos } from "@/hooks/useTodos";
import { addTodo, deleteTodo, findSessionTodo } from "@/lib/todo-client";

/** Sidebar row action: add the conversation to the todo list, or remove it again. */
export function SessionTodoButton({ sessionId, title, style }: {
  sessionId: string;
  /** Todo text and link title for a newly added item. */
  title: string;
  style: CSSProperties;
}) {
  const { t } = useI18n();
  const { snapshot } = useTodos();
  const existing = snapshot ? findSessionTodo(snapshot.items, sessionId) : undefined;
  const label = t(existing ? "todo.removeSession" : "todo.addSession");
  const color = existing ? "var(--accent)" : "var(--text-dim)";

  return (
    <button
      type="button"
      data-session-todo-button
      onClick={(event) => {
        event.stopPropagation();
        if (existing) void deleteTodo(existing.id);
        else void addTodo(title, { sessionId, sessionTitle: title });
      }}
      disabled={!snapshot}
      title={label}
      aria-label={label}
      aria-pressed={!!existing}
      style={{ ...style, color, opacity: snapshot ? 1 : 0.5, cursor: snapshot ? "pointer" : "default" }}
      onMouseEnter={(event) => {
        if (!snapshot) return;
        event.currentTarget.style.background = "var(--bg-hover)";
        event.currentTarget.style.color = "var(--accent)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "none";
        event.currentTarget.style.color = color;
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="4" />
        {existing ? <polyline points="8 12.5 11 15.5 16.5 9" /> : <path d="M12 8v8M8 12h8" />}
      </svg>
    </button>
  );
}
