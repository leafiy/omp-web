"use client";

import { createContext, useContext } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTodos } from "@/hooks/useTodos";
import { addTodo, deleteTodo, findMessageTodo, todoExcerpt } from "@/lib/todo-client";
import type { TodoSourceRole } from "@/lib/todo-types";

/** Supplied by the chat window: which conversation the rendered messages belong to. */
export interface TodoMessageContextValue {
  sessionId?: string;
  sessionTitle?: string;
  /** Entry ID that starts the history turn holding this message. */
  turnIdFor: (entryId: string) => string | undefined;
}

export const TodoMessageContext = createContext<TodoMessageContextValue | null>(null);

/** Markdown noise is dropped from the default todo text; the item stays editable. */
function plainExcerpt(text: string): string {
  return todoExcerpt(text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]+/g, ""));
}

/**
 * Adds one message to the shared todo list, or removes it when it is already
 * there. Hidden until the message has a persisted entry ID.
 */
export function TodoMessageButton({ entryId, role, text, visible = true }: {
  entryId?: string;
  role: TodoSourceRole;
  /** Display text of the message (user text already summarized). */
  text: string;
  visible?: boolean;
}) {
  const context = useContext(TodoMessageContext);
  const { snapshot } = useTodos();
  const { t } = useI18n();
  const sessionId = context?.sessionId;
  if (!context || !sessionId || !entryId || !snapshot) return null;

  const existing = findMessageTodo(snapshot.items, sessionId, entryId);
  const label = existing ? t(existing.done ? "todo.inListDone" : "todo.inList") : t("todo.addShort");
  const title = existing ? t("todo.removeMessageTitle") : t("todo.addMessageTitle");
  const toggle = () => {
    if (existing) {
      void deleteTodo(existing.id);
      return;
    }
    const fallback = t(role === "user" ? "todo.userMessage" : "todo.assistantMessage");
    void addTodo(plainExcerpt(text) || fallback, {
      sessionId,
      ...(context.sessionTitle?.trim() ? { sessionTitle: context.sessionTitle.trim() } : {}),
      entryId,
      ...(context.turnIdFor(entryId) ? { turnId: context.turnIdFor(entryId) } : {}),
      role,
    });
  };
  const color = existing ? "var(--accent)" : "var(--text-dim)";

  return (
    <button
      type="button"
      data-todo-message-button
      onClick={toggle}
      title={title}
      aria-label={title}
      aria-pressed={!!existing}
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "3px 8px", height: 22,
        background: "none", border: "none", borderRadius: 5,
        color, cursor: "pointer",
        fontSize: 11, fontWeight: 400, whiteSpace: "nowrap",
        opacity: visible || existing ? 1 : 0,
        pointerEvents: visible || existing ? "auto" : "none",
        transition: "opacity 0.12s, color 0.12s",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--accent)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = color; }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="4" />
        {existing ? <polyline points="8 12.5 11 15.5 16.5 9" /> : <path d="M12 8v8M8 12h8" />}
      </svg>
      {label}
    </button>
  );
}
