"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useTodos } from "@/hooks/useTodos";
import { addTodo, deleteTodo, findSessionTodo, setTodoDone } from "@/lib/todo-client";

const MENU_WIDTH = 210;

/** Right-click menu of a sidebar conversation row: add it to / manage it in the todo list. */
export function SessionTodoMenu({ x, y, sessionId, title, onClose }: {
  x: number;
  y: number;
  sessionId: string;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { snapshot } = useTodos();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const existing = snapshot ? findSessionTodo(snapshot.items, sessionId) : undefined;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const height = menu?.offsetHeight ?? 0;
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
  }, [x, y, existing?.id, existing?.done]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    };
    const dismiss = () => onClose();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [onClose]);

  const items: { key: string; label: string; disabled?: boolean; danger?: boolean; run: () => void }[] = existing
    ? [
      { key: "done", label: t(existing.done ? "todo.sessionMarkOpen" : "todo.sessionMarkDone"), run: () => { void setTodoDone(existing.id, !existing.done); } },
      { key: "remove", label: t("todo.removeSession"), danger: true, run: () => { void deleteTodo(existing.id); } },
    ]
    : [{ key: "add", label: t("todo.addSession"), disabled: !snapshot, run: () => { void addTodo(title, { sessionId, sessionTitle: title }); } }];

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={title}
      data-session-todo-menu
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}
      style={{
        position: "fixed", left: position.left, top: position.top, zIndex: 1000,
        width: MENU_WIDTH, padding: 4,
        border: "1px solid var(--border)", borderRadius: 8,
        background: "var(--bg-panel)", boxShadow: "0 8px 24px rgba(0,0,0,.2)",
      }}
    >
      <div style={{ padding: "4px 10px 6px", fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={title}>
        {title}
      </div>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={(event) => { event.stopPropagation(); item.run(); onClose(); }}
          style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 32,
            padding: "6px 10px", border: "none", borderRadius: 5, background: "none", textAlign: "left",
            color: item.disabled ? "var(--text-dim)" : item.danger ? "#ef4444" : "var(--text)",
            fontSize: 12.5, cursor: item.disabled ? "default" : "pointer",
          }}
          onMouseEnter={(event) => { if (!item.disabled) event.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "none"; }}
          onFocus={(event) => { if (!item.disabled) event.currentTarget.style.background = "var(--bg-hover)"; }}
          onBlur={(event) => { event.currentTarget.style.background = "none"; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect x="3" y="3" width="18" height="18" rx="4" />
            {item.key === "add" ? <path d="M12 8v8M8 12h8" /> : item.key === "remove" ? <path d="M8 12h8" /> : <polyline points="8 12.5 11 15.5 16.5 9" />}
          </svg>
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
