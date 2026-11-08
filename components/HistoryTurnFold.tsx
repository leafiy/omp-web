"use client";
import type { Ref } from "react";
import type { HistoryTurnState } from "@/hooks/useAgentSession";
import type { HistoryTurnSummary } from "@/lib/history-turns";
import { formatTime } from "./MessageView";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Disclosure bar for one history turn; it stays in place while the turn opens below it. */
export function HistoryTurnToggle({ turn, state, onToggle, t }: { turn: HistoryTurnSummary; state?: HistoryTurnState; onToggle: () => void; t: Translate }) {
  const expanded = Boolean(state?.expanded && state.messages);
  const action = state?.loading ? t("chat.turnLoading")
    : state?.error ? t(state.error === "changed" ? "chat.turnChanged" : "chat.turnLoadFailed")
      : t(expanded ? "chat.turnCollapse" : "chat.turnExpand");
  const replies = turn.kind === "preamble" ? turn.count : turn.count - 1;
  const parts = [
    ...(turn.kind === "compaction" ? [t("chat.turnCompaction")] : turn.kind === "preamble" ? [t("chat.turnPreamble")] : []),
    action,
  ];
  if (replies > 0) parts.push(`${replies} ${t(replies === 1 ? "chat.message" : "chat.messages")}`);
  if (turn.toolCalls > 0) parts.push(`${turn.toolCalls} ${t(turn.toolCalls === 1 ? "chat.toolCall" : "chat.toolCalls")}`);
  const time = turn.kind === "user" ? null : formatTime(turn.timestamp);
  if (time) parts.push(time);
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-busy={state?.loading || undefined}
      disabled={state?.loading}
      onClick={onToggle}
      style={{
        display: "flex", alignItems: "center", gap: 8, minHeight: 24, maxWidth: "100%", padding: "2px 0", marginBottom: 10,
        border: "none", background: "transparent", color: state?.error ? "#d97706" : "var(--text-muted)",
        cursor: state?.loading ? "progress" : "pointer", fontSize: 12, textAlign: "left",
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
        <polyline points="4 2.5 7.5 6 4 9.5" />
      </svg>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{parts.join(" · ")}</span>
    </button>
  );
}

/**
 * A turn that is not loaded or was collapsed: the prompt preview (clamped)
 * plus its toggle. Clicking either opens the whole turn.
 */
export function CollapsedHistoryTurn({ turn, state, onToggle, t, rowRef }: { turn: HistoryTurnSummary; state?: HistoryTurnState; onToggle: () => void; t: Translate; rowRef?: Ref<HTMLDivElement> }) {
  const time = formatTime(turn.timestamp);
  return (
    <div ref={rowRef} data-history-turn={turn.id}>
      {turn.kind === "user" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", marginBottom: 4 }}>
          <button
            type="button"
            className="sf-user-bubble"
            onClick={onToggle}
            disabled={state?.loading}
            title={t("chat.turnExpand")}
            style={{
              maxWidth: "85%", minWidth: 0, textAlign: "left", cursor: state?.loading ? "progress" : "pointer",
              background: "var(--user-bg)", border: "1px solid rgba(59,130,246,0.2)", borderRadius: 12, padding: "8px 12px",
              fontSize: 14, lineHeight: 1.6, color: "var(--text)", wordBreak: "break-word",
            }}
          >
            <span style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {turn.images > 0 && <span style={{ color: "var(--text-muted)", fontSize: 12, marginRight: 6 }}>[{t("chat.turnImages", { count: turn.images })}]</span>}
              {turn.text || (turn.images > 0 ? null : <span style={{ color: "var(--text-muted)" }}>{t("chat.turnNoText")}</span>)}
            </span>
          </button>
          {time && <span style={{ marginTop: 3, fontSize: 11, color: "var(--text-dim)" }}>{time}</span>}
        </div>
      )}
      <HistoryTurnToggle turn={turn} state={state} onToggle={onToggle} t={t} />
    </div>
  );
}
