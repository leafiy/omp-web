"use client";

import { createContext, useContext, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTodos } from "@/hooks/useTodos";
import { addTodo, deleteTodo, findMessageTodo, newTodoId, resolveMessageLink, todoExcerpt } from "@/lib/todo-client";
import type { TodoSource, TodoSourceRole } from "@/lib/todo-types";

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
 * there. A message from the current run has no entry ID in the browser yet;
 * its link is then looked up in the persisted history when clicked.
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
  // What this button added while the message had no entry ID of its own.
  const [added, setAdded] = useState<{ todoId: string; entryId?: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const sessionId = context?.sessionId;
  if (!context || !sessionId || !snapshot) return null;

  const linkedEntryId = entryId ?? added?.entryId;
  const existing = (linkedEntryId ? findMessageTodo(snapshot.items, sessionId, linkedEntryId) : undefined)
    ?? (added ? snapshot.items.find((item) => item.id === added.todoId) : undefined);
  const label = existing ? t(existing.done ? "todo.inListDone" : "todo.inList") : t("todo.addShort");
  const title = existing ? t("todo.removeMessageTitle") : t("todo.addMessageTitle");
  const toggle = async () => {
    if (resolving) return;
    if (existing) {
      setAdded(null);
      void deleteTodo(existing.id);
      return;
    }
    const todoText = plainExcerpt(text) || t(role === "user" ? "todo.userMessage" : "todo.assistantMessage");
    const source: TodoSource = {
      sessionId,
      ...(context.sessionTitle?.trim() ? { sessionTitle: context.sessionTitle.trim() } : {}),
      role,
    };
    if (entryId) {
      const turnId = context.turnIdFor(entryId);
      void addTodo(todoText, { ...source, entryId, ...(turnId ? { turnId } : {}) });
      return;
    }
    setResolving(true);
    let link: { entryId: string; turnId: string } | null = null;
    try { link = await resolveMessageLink(sessionId, role, text); } catch { /* keep the conversation link */ }
    const todoId = newTodoId();
    setAdded({ todoId, ...(link ? { entryId: link.entryId } : {}) });
    setResolving(false);
    // Not written yet: the item still opens the conversation.
    void addTodo(todoText, link ? { ...source, entryId: link.entryId, turnId: link.turnId } : source, todoId);
  };
  const color = existing ? "var(--accent)" : "var(--text-dim)";

  return (
    <button
      type="button"
      data-todo-message-button
      onClick={() => { void toggle(); }}
      disabled={resolving}
      title={title}
      aria-label={title}
      aria-pressed={!!existing}
      aria-busy={resolving}
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "3px 8px", height: 22,
        background: "none", border: "none", borderRadius: 5,
        color, cursor: resolving ? "progress" : "pointer",
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
