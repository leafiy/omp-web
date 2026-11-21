"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useTodoJumpNotice, useTodos } from "@/hooks/useTodos";
import { TODO_JUMP_HIGHLIGHT_CLASS } from "@/hooks/useTodoJump";
import {
  addTodo,
  clearDoneTodos,
  deleteTodo,
  dismissTodoError,
  dismissTodoJumpNotice,
  finishTodoJump,
  newTodoId,
  requestTodoJump,
  setTodoDone,
  setTodoText,
} from "@/lib/todo-client";
import { sortTodosForDisplay, TODO_TEXT_MAX, type TodoItem } from "@/lib/todo-types";

const SHOW_DONE_KEY = "omp-web:todo-show-done";
const CARD_WIDTH = 380;

function isImeEnter(event: ReactKeyboardEvent) {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

function readShowDone(): boolean {
  try { return window.localStorage.getItem(SHOW_DONE_KEY) === "1"; } catch { return false; }
}

const iconButton: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 24, height: 24, padding: 0, flexShrink: 0,
  background: "none", border: "none", borderRadius: 5,
  color: "var(--text-dim)", cursor: "pointer",
  transition: "background 0.12s, color 0.12s",
};

function hoverIcon(color = "var(--text)") {
  return {
    onMouseEnter: (event: ReactMouseEvent<HTMLButtonElement>) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = color; },
    onMouseLeave: (event: ReactMouseEvent<HTMLButtonElement>) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-dim)"; },
  };
}

function CheckBox({ done, label, onToggle }: { done: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={label}
      title={label}
      onClick={onToggle}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 18, height: 18, marginTop: 1, padding: 0, flexShrink: 0,
        border: `1.5px solid ${done ? "var(--accent)" : "var(--text-dim)"}`, borderRadius: 5,
        background: done ? "var(--accent)" : "transparent",
        color: "#fff", cursor: "pointer", transition: "background 0.12s, border-color 0.12s",
      }}
    >
      {done && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="5 12.5 10 17.5 19 7.5" />
        </svg>
      )}
    </button>
  );
}

function TodoRow({ item, number, editing, onStartEdit, onEditChange, onCommitEdit, onCancelEdit, onJump }: {
  item: TodoItem;
  /** Open items are numbered like the agent-readable copies ("todo item 2"). */
  number?: number;
  editing: string | null;
  onStartEdit: () => void;
  onEditChange: (text: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onJump: () => void;
}) {
  const { t } = useI18n();
  const source = item.source;
  const sourceLabel = source
    ? source.entryId || source.role
      ? `${source.sessionTitle || t("todo.untitled")} · ${t(source.role === "assistant" ? "todo.assistantMessage" : "todo.userMessage")}`
      : t("todo.conversation")
    : null;
  const jumpLabel = t(source?.entryId ? "todo.jumpMessage" : "todo.jump");

  return (
    <li
      data-todo-item={item.id}
      style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 8px", borderRadius: 6, listStyle: "none" }}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
    >
      <CheckBox done={item.done} label={t(item.done ? "todo.markOpen" : "todo.markDone")} onToggle={() => { void setTodoDone(item.id, !item.done); }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing !== null ? (
          <textarea
            autoFocus
            value={editing}
            maxLength={TODO_TEXT_MAX}
            rows={Math.min(5, Math.max(1, editing.split("\n").length))}
            onChange={(event) => onEditChange(event.target.value)}
            onBlur={onCommitEdit}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancelEdit(); }
              else if (event.key === "Enter" && !event.shiftKey && !isImeEnter(event)) { event.preventDefault(); onCommitEdit(); }
            }}
            style={{
              display: "block", width: "100%", resize: "none", boxSizing: "border-box",
              padding: "2px 6px", margin: "-3px 0", fontSize: 13, lineHeight: 1.45, fontFamily: "inherit",
              color: "var(--text)", background: "var(--bg)", border: "1px solid var(--accent)", borderRadius: 5, outline: "none",
            }}
          />
        ) : (
          <div
            title={item.text}
            onClick={source ? onJump : onStartEdit}
            style={{
              fontSize: 13, lineHeight: 1.45, color: item.done ? "var(--text-dim)" : "var(--text)",
              textDecoration: item.done ? "line-through" : "none",
              overflowWrap: "anywhere", whiteSpace: "pre-wrap", cursor: source ? "pointer" : "text",
              display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
            }}
          >
            {number !== undefined && <span style={{ marginRight: 5, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{number}.</span>}
            {item.text}
          </div>
        )}
        {sourceLabel && (
          <button
            type="button"
            onClick={onJump}
            title={jumpLabel}
            style={{
              display: "flex", alignItems: "center", gap: 4, maxWidth: "100%", marginTop: 3, padding: 0,
              background: "none", border: "none", color: "var(--text-dim)", fontSize: 11, cursor: "pointer", textAlign: "left",
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sourceLabel}</span>
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 1, flexShrink: 0 }}>
        {source && (
          <button type="button" onClick={onJump} title={jumpLabel} aria-label={jumpLabel} style={iconButton} {...hoverIcon("var(--accent)")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 17 17 7" /><path d="M8 7h9v9" />
            </svg>
          </button>
        )}
        <button type="button" onClick={onStartEdit} title={t("todo.edit")} aria-label={t("todo.edit")} style={iconButton} {...hoverIcon("var(--accent)")}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
        </button>
        <button type="button" onClick={() => { void deleteTodo(item.id); }} title={t("todo.delete")} aria-label={t("todo.delete")} style={iconButton} {...hoverIcon("#ef4444")}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
      </div>
    </li>
  );
}

/**
 * Top-bar "done/total" todo badge with a floating card. The list lives on the
 * server, so every signed-in device sees the same items.
 */
export function TodoWidget({ compact = false, currentSessionId, onOpenSession, onOpen, style }: {
  compact?: boolean;
  currentSessionId: string | null;
  /** Select another conversation; resolves false when it no longer exists. */
  onOpenSession: (sessionId: string) => Promise<boolean>;
  onOpen?: () => void;
  style?: CSSProperties;
}) {
  const { t } = useI18n();
  const { snapshot, error } = useTodos();
  const notice = useTodoJumpNotice();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  useEffect(() => { setShowDone(readShowDone()); }, []);

  const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
  const sorted = useMemo(() => sortTodosForDisplay(items), [items]);
  const total = items.length;
  const doneCount = sorted.done.length;

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = window.innerWidth;
    const width = Math.min(CARD_WIDTH, viewport - 16);
    const left = compact ? (viewport - width) / 2 : Math.max(8, Math.min(rect.right - width, viewport - width - 8));
    setPosition({ top: rect.bottom + 4, left, width });
  }, [compact]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, place]);

  const close = useCallback(() => {
    setOpen(false);
    setEditing(null);
    setConfirmClear(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (cardRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || editingRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key, true); };
  }, [open, close]);

  useEffect(() => {
    if (!open || compact) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open, compact]);

  useEffect(() => {
    if (!confirmClear) return;
    const timer = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmClear]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => dismissTodoJumpNotice(), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  const toggleShowDone = () => {
    setShowDone((value) => {
      try { window.localStorage.setItem(SHOW_DONE_KEY, value ? "0" : "1"); } catch { /* private mode */ }
      return !value;
    });
  };

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || !snapshot) return;
    setDraft("");
    // New items join the end of the numbered list; bring the row into view.
    const id = newTodoId();
    void addTodo(text, undefined, id);
    requestAnimationFrame(() => {
      cardRef.current?.querySelector(`[data-todo-item="${id}"]`)?.scrollIntoView({ block: "nearest" });
    });
  };

  const commitEdit = () => {
    const current = editingRef.current;
    if (!current) return;
    setEditing(null);
    const original = items.find((item) => item.id === current.id);
    if (original && current.text.trim() && current.text.trim() !== original.text) void setTodoText(current.id, current.text);
  };

  const jump = async (item: TodoItem) => {
    const source = item.source;
    if (!source) return;
    const request = requestTodoJump(source);
    close();
    if (source.sessionId === currentSessionId) return;
    const found = await onOpenSession(source.sessionId);
    if (!found) finishTodoJump(request.nonce, "sessionNotFound");
  };

  const errorText = error === "load" ? t("todo.errorLoad") : error === "save" ? t("todo.errorSave") : error === "limit" ? t("todo.errorLimit") : null;
  const badgeTitle = t("todo.badgeTitle", { done: doneCount, total });
  const renderRow = (item: TodoItem, index: number | null) => (
    <TodoRow
      key={item.id}
      item={item}
      number={index === null ? undefined : index + 1}
      editing={editing?.id === item.id ? editing.text : null}
      onStartEdit={() => setEditing({ id: item.id, text: item.text })}
      onEditChange={(text) => setEditing({ id: item.id, text })}
      onCommitEdit={commitEdit}
      onCancelEdit={() => setEditing(null)}
      onJump={() => { void jump(item); }}
    />
  );

  return (
    <>
      <style>{`
        @keyframes todo-jump-flash {
          0%, 30% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 7%, transparent); }
          100% { box-shadow: 0 0 0 2px transparent; background: transparent; }
        }
        .${TODO_JUMP_HIGHLIGHT_CLASS} { border-radius: 8px; animation: todo-jump-flash 2.2s ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .${TODO_JUMP_HIGHLIGHT_CLASS} { animation: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent); }
        }
      `}</style>
      <button
        ref={triggerRef}
        type="button"
        data-todo-trigger
        aria-haspopup="dialog"
        aria-expanded={open}
        title={badgeTitle}
        aria-label={badgeTitle}
        onClick={() => {
          if (open) { close(); return; }
          onOpen?.();
          setOpen(true);
        }}
        style={{
          display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
          height: compact ? 44 : 36, padding: compact ? "0 8px" : "0 12px",
          background: open ? "var(--bg-selected)" : "none",
          border: "none",
          borderLeft: compact ? "none" : "1px solid var(--border)",
          borderTop: compact ? "none" : open ? "2px solid var(--accent)" : "2px solid transparent",
          color: open ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer", fontSize: 11, whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
          transition: "color 0.1s, background 0.1s",
          ...style,
        }}
        onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)"; }}
      >
        <svg width={compact ? 16 : 13} height={compact ? 16 : 13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={{ color: total > 0 && doneCount === total ? "var(--accent)" : undefined, flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <polyline points="8 12.5 11 15.5 16.5 9" />
        </svg>
        <span>{snapshot ? `${doneCount}/${total}` : "–"}</span>
        {!compact && <span style={{ color: "var(--text-dim)" }}>{t("todo.label")}</span>}
      </button>

      {notice && !open && typeof document !== "undefined" && createPortal(
        <div
          role="status"
          onClick={() => dismissTodoJumpNotice()}
          style={{
            position: "fixed", top: (triggerRef.current?.getBoundingClientRect().bottom ?? 40) + 6, right: 12, zIndex: 560,
            maxWidth: "min(360px, calc(100vw - 24px))", padding: "8px 12px",
            border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)",
            boxShadow: "0 8px 24px rgba(0,0,0,.18)", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, cursor: "pointer",
          }}
        >
          {t(notice.kind === "sessionNotFound" ? "todo.sessionNotFound" : "todo.messageNotFound")}
        </div>,
        document.body,
      )}

      {open && position && typeof document !== "undefined" && createPortal(
        <div
          ref={cardRef}
          role="dialog"
          aria-label={t("todo.title")}
          data-todo-card
          style={{
            position: "fixed", top: position.top, left: position.left, width: position.width, zIndex: 550,
            maxHeight: `calc(var(--app-viewport-height, 100dvh) - ${Math.round(position.top) + 12}px)`,
            display: "flex", flexDirection: "column",
            border: "1px solid var(--border)", borderRadius: 10,
            background: "var(--bg-panel)", boxShadow: "0 14px 36px rgba(0,0,0,.18)",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 8px" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("todo.title")}</span>
            <span style={{ fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{t("todo.summary", { done: doneCount, total })}</span>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={close} title={t("todo.close")} aria-label={t("todo.close")} style={iconButton} {...hoverIcon()}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <form
            onSubmit={(event) => { event.preventDefault(); submitDraft(); }}
            style={{ display: "flex", gap: 6, padding: "0 12px 8px" }}
          >
            <input
              ref={inputRef}
              value={draft}
              maxLength={TODO_TEXT_MAX}
              placeholder={t("todo.addPlaceholder")}
              aria-label={t("todo.addPlaceholder")}
              disabled={!snapshot}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isImeEnter(event)) event.preventDefault();
              }}
              style={{
                flex: 1, minWidth: 0, height: compact ? 36 : 30, padding: "0 10px",
                fontSize: compact ? 16 : 13, color: "var(--text)", background: "var(--bg)",
                border: "1px solid var(--border)", borderRadius: 6, outline: "none",
              }}
              onFocus={(event) => { event.currentTarget.style.borderColor = "var(--accent)"; }}
              onBlur={(event) => { event.currentTarget.style.borderColor = "var(--border)"; }}
            />
            <button
              type="submit"
              disabled={!draft.trim() || !snapshot}
              style={{
                height: compact ? 36 : 30, padding: "0 12px", flexShrink: 0,
                border: "none", borderRadius: 6, fontSize: 12,
                background: draft.trim() ? "var(--accent)" : "var(--bg-hover)",
                color: draft.trim() ? "#fff" : "var(--text-dim)",
                cursor: draft.trim() ? "pointer" : "default",
              }}
            >
              {t("todo.add")}
            </button>
          </form>

          {errorText && (
            <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, margin: "0 12px 8px", padding: "6px 8px", borderRadius: 6, background: "rgba(239,68,68,0.08)", color: "#ef4444", fontSize: 12, lineHeight: 1.45 }}>
              <span style={{ flex: 1 }}>{errorText}</span>
              {error !== "load" && (
                <button type="button" onClick={() => dismissTodoError()} aria-label={t("todo.close")} style={{ ...iconButton, width: 18, height: 18, color: "#ef4444" }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              )}
            </div>
          )}

          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 4px 6px", borderTop: "1px solid var(--border)" }}>
            {!snapshot ? (
              <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-dim)" }}>{error === "load" ? t("todo.errorLoad") : t("todo.loading")}</div>
            ) : total === 0 ? (
              <div style={{ padding: "16px 12px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>{t("todo.empty")}</div>
            ) : (
              <>
                {sorted.open.length > 0 && <ul style={{ margin: 0, padding: "4px 0 0" }}>{sorted.open.map((item, index) => renderRow(item, index))}</ul>}
                {doneCount > 0 && (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 8px 2px" }}>
                      <button
                        type="button"
                        aria-expanded={showDone}
                        onClick={toggleShowDone}
                        style={{ display: "flex", alignItems: "center", gap: 6, padding: 0, background: "none", border: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: showDone ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}>
                          <path d="M3.5 2 6.5 5 3.5 8" />
                        </svg>
                        {t("todo.completed", { count: doneCount })}
                      </button>
                      <span style={{ flex: 1 }} />
                      <button
                        type="button"
                        onClick={() => {
                          if (!confirmClear) { setConfirmClear(true); return; }
                          setConfirmClear(false);
                          void clearDoneTodos();
                        }}
                        style={{
                          padding: "2px 6px", border: "none", borderRadius: 5, fontSize: 11, cursor: "pointer",
                          background: confirmClear ? "#ef4444" : "none", color: confirmClear ? "#fff" : "var(--text-dim)",
                        }}
                      >
                        {confirmClear ? t("todo.clearDoneConfirm", { count: doneCount }) : t("todo.clearDone")}
                      </button>
                    </div>
                    {showDone && <ul style={{ margin: 0, padding: 0 }}>{sorted.done.map((item) => renderRow(item, null))}</ul>}
                  </>
                )}
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
