"use client";

import { useI18n } from "@/hooks/useI18n";
import type { AgentTask, AgentTaskSnapshot } from "@/lib/agent-task-types";

/** Metadata only. Child transcripts never enter the main conversation. */
export function AgentTasksPanel({ snapshot, mainRunning, stale = false, onOpen }: { snapshot: AgentTaskSnapshot | null; mainRunning: boolean; stale?: boolean; onOpen?: (task: AgentTask) => void }) {
  const { t } = useI18n();
  if (!snapshot) return null;
  const tasks = snapshot.tasks.filter(task => !task.hidden && !task.ambient);
  if (!tasks.length && snapshot.coverage !== "unavailable") return null;
  // A shell launched inside an active agent is a nested detail, not a second work group.
  const active = tasks.filter(task => task.active && !tasks.some(parent => parent.id === task.parentId && parent.active)).length;
  const unknown = tasks.some(task => task.status === "unknown");
  return <details style={{ margin: "0 auto 10px", maxWidth: 820, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", color: "var(--text)", fontSize: 13 }}>
    <summary style={{ cursor: "pointer", padding: "10px 12px", overflowWrap: "anywhere" }}>
      <span role="status">{mainRunning ? t("tasks.mainRunning") : t("tasks.mainIdle")} · {stale ? t("tasks.disconnected") : active ? `${t("tasks.active", { count: active })}${unknown ? ` · ${t("tasks.unknown")}` : ""}` : unknown ? t("tasks.unknown") : tasks.length ? t("tasks.ended") : t("tasks.unavailable")}</span>
    </summary>
    <div style={{ padding: "0 12px 10px", maxHeight: 260, overflowY: "auto" }}>
      {snapshot.coverage !== "native" && <p style={{ color: "var(--text-muted)", margin: "0 0 8px" }}>{t("tasks.partial")}</p>}
      {tasks.map(task => <button type="button" key={task.id} onClick={() => onOpen?.(task)} disabled={!onOpen} aria-label={`${task.title} · ${t("tasks.conversation")}`} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", color: "inherit", border: "none", cursor: onOpen ? "pointer" : "default", padding: tasks.some(parent => parent.id === task.parentId) ? "7px 0 7px 14px" : "7px 0", borderTop: "1px solid var(--border)", overflowWrap: "anywhere" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", justifyContent: "space-between" }}>
          <span>{task.title}</span><span style={{ flexShrink: 0, color: task.active ? "var(--accent)" : "var(--text-muted)" }}>{t(`tasks.${stale && task.active ? "unknown" : task.status}`)}</span>
        </div>
        {task.detail && <div style={{ marginTop: 3, color: "var(--text-muted)" }}>{task.detail === "details_unavailable" ? t("tasks.noDetails") : task.detail}</div>}
      </button>)}
    </div>
  </details>;
}
