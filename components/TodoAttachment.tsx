"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTodos } from "@/hooks/useTodos";
import { isCommandDraft } from "@/lib/pasted-text";
import { appendTodoList, mentionsTodoList } from "@/lib/todo-attachment";
import { sortTodosForDisplay } from "@/lib/todo-types";

function ListIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <polyline points="7 9.5 8.5 11 11 8.5" />
      <path d="M13.5 10h3.5M7 15h10" />
    </svg>
  );
}

/** The todo list attached to a sent message, folded like a pasted document. */
export function TodoListAttachment({ text }: { text: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const openCount = useMemo(() => text.split("\n").filter((line) => /^\d+\. /.test(line)).length, [text]);
  return (
    <div style={{ margin: "6px 0", maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", overflow: "hidden" }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0, padding: "6px 10px", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, textAlign: "left" }}
      >
        <ListIcon />
        <span style={{ flex: 1, minWidth: 0, color: "var(--text)" }}>{t("todo.attachedList")}</span>
        <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>{t("todo.attachedOpenCount", { count: openCount })}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}>
          <path d="M3.5 2 6.5 5 3.5 8" />
        </svg>
      </button>
      {open && (
        <pre style={{ margin: 0, padding: "8px 10px", maxHeight: 360, overflow: "auto", borderTop: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text)" }}>{text}</pre>
      )}
    </div>
  );
}

/**
 * A draft that mentions the todo list gets the current numbered list appended
 * when it is sent, unless the user dismisses the chip. Command drafts never do.
 * `attach` is stable and always reads the latest draft/list state.
 */
export function useTodoListAttachment(draft: string): { chip: ReactNode; attach: (outgoing: string) => string } {
  const { t } = useI18n();
  const { snapshot } = useTodos();
  const mentioned = !isCommandDraft(draft) && mentionsTodoList(draft);
  const [dismissed, setDismissed] = useState(false);
  // Dismissal covers this mention only; mentioning it again later asks again.
  useEffect(() => { if (!mentioned) setDismissed(false); }, [mentioned]);

  const items = snapshot?.items ?? null;
  const openCount = useMemo(() => items ? sortTodosForDisplay(items).open.length : 0, [items]);
  const active = mentioned && !dismissed && !!items && items.length > 0;
  const latest = useRef({ active, items });
  latest.current = { active, items };

  const attach = useCallback((outgoing: string) => {
    const { active: on, items: list } = latest.current;
    return on && list && outgoing.trim() ? appendTodoList(outgoing, list) : outgoing;
  }, []);

  const chip = active ? (
    <div
      role="status"
      data-todo-list-chip
      style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%", marginBottom: 6, padding: "3px 4px 3px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12 }}
    >
      <ListIcon />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("todo.willAttach", { count: openCount })}</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        title={t("todo.dontAttach")}
        aria-label={t("todo.dontAttach")}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
        onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-dim)"; }}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
        </svg>
      </button>
    </div>
  ) : null;

  return { chip, attach };
}
