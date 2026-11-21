"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AgentTask, AgentTaskSnapshot } from "@/lib/agent-task-types";

/** Metadata only. Child transcripts never enter the main conversation. */
export function AgentTasksPanel({ snapshot, mainRunning, stale = false, onOpen, onStop }: {
  snapshot: AgentTaskSnapshot | null;
  mainRunning: boolean;
  stale?: boolean;
  onOpen?: (task: AgentTask) => void;
  /** Engines with a native per-task stop control (Claude Code's stop_task). */
  onStop?: (task: AgentTask) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [stopping, setStopping] = useState<Set<string>>(() => new Set());
  if (!snapshot) return null;
  const tasks = snapshot.tasks.filter(task => !task.hidden && !task.ambient);
  if (!tasks.length && snapshot.coverage !== "unavailable") return null;
  // A shell launched inside an active agent is a nested detail, not a second work group.
  const active = tasks.filter(task => task.active && !tasks.some(parent => parent.id === task.parentId && parent.active)).length;
  const unknown = tasks.some(task => task.status === "unknown");
  const stop = (task: AgentTask) => {
    if (!onStop || stopping.has(task.id)) return;
    setStopping(current => new Set(current).add(task.id));
    void Promise.resolve(onStop(task)).finally(() => setStopping(current => { const next = new Set(current); next.delete(task.id); return next; }));
  };
  return <details style={{ margin: "0 auto 10px", maxWidth: 820, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", color: "var(--text)", fontSize: 13 }}>
    <summary style={{ cursor: "pointer", padding: "10px 12px", overflowWrap: "anywhere" }}>
      <span role="status">{mainRunning ? t("tasks.mainRunning") : t("tasks.mainIdle")} · {stale ? t("tasks.disconnected") : active ? `${t("tasks.active", { count: active })}${unknown ? ` · ${t("tasks.unknown")}` : ""}` : unknown ? t("tasks.unknown") : tasks.length ? t("tasks.ended") : t("tasks.unavailable")}</span>
    </summary>
    <div style={{ padding: "0 12px 10px", maxHeight: 260, overflowY: "auto" }}>
      {snapshot.coverage !== "native" && <p style={{ color: "var(--text-muted)", margin: "0 0 8px" }}>{t("tasks.partial")}</p>}
      {tasks.map(task => {
        const nested = tasks.some(parent => parent.id === task.parentId);
        const canStop = Boolean(onStop) && task.active && !stale;
        return <div key={task.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, borderTop: "1px solid var(--border)", padding: nested ? "0 0 0 14px" : 0 }}>
          <button type="button" onClick={() => onOpen?.(task)} disabled={!onOpen} aria-label={`${task.title} · ${t("tasks.conversation")}`} style={{ display: "block", flex: 1, minWidth: 0, textAlign: "left", background: "transparent", color: "inherit", border: "none", cursor: onOpen ? "pointer" : "default", padding: "7px 0", overflowWrap: "anywhere" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", justifyContent: "space-between" }}>
              <span>{task.title}</span><span style={{ flexShrink: 0, color: task.active ? "var(--accent)" : "var(--text-muted)" }}>{t(`tasks.${stale && task.active ? "unknown" : task.status}`)}</span>
            </div>
            {task.detail && <div style={{ marginTop: 3, color: "var(--text-muted)" }}>{task.detail === "details_unavailable" ? t("tasks.noDetails") : task.detail}</div>}
          </button>
          {canStop && <button type="button" onClick={() => stop(task)} disabled={stopping.has(task.id)} title={t("tasks.stopTitle")} style={{ flexShrink: 0, margin: "6px 0", padding: "2px 8px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", color: stopping.has(task.id) ? "var(--text-dim)" : "#ef4444", cursor: stopping.has(task.id) ? "default" : "pointer", fontSize: 11 }}>
            {stopping.has(task.id) ? t("tasks.stopping") : t("tasks.stop")}
          </button>}
        </div>;
      })}
    </div>
  </details>;
}
