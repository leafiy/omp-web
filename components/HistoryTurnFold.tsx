"use client";
import type { HistoryTurnState } from "@/hooks/useAgentSession";
import type { HistoryTurnSummary } from "@/lib/history-turns";
import { formatTime } from "./MessageView";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * Disclosure bar for one history turn. It sits directly under the prompt,
 * which is always shown in full; only the reply opens and closes below it.
 */
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
