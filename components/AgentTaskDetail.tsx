"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AgentTaskDetail as TaskDetail } from "@/lib/agent-task-types";

export function AgentTaskDetail({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<TaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRef<() => void>(() => {});
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    let disposed = false, pending = false, auto = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    setData(null); setError(null); atBottom.current = true;
    async function load() {
      if (disposed || pending) return;
      pending = true; clearTimeout(timer); setBusy(true);
      controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), 15_000);
      try {
        const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          if ([404, 410].includes(response.status)) auto = false;
          throw new Error(response.status === 410 ? "tasks.sessionClosed" : "tasks.loadFailed");
        }
        const next = await response.json() as TaskDetail;
        if (next.task?.id !== taskId || !Array.isArray(next.messages)) throw new Error("tasks.loadFailed");
        if (!disposed) { setData(next); setError(null); auto = next.task.active; }
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error && failure.message === "tasks.sessionClosed" ? "tasks.sessionClosed" : "tasks.loadFailed");
      } finally {
        clearTimeout(deadline); pending = false;
        if (!disposed) { setBusy(false); if (auto) timer = setTimeout(() => void load(), 3000); }
      }
    }
    refresh.current = () => { void load(); };
    void load();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); };
  }, [sessionId, taskId]);
  useEffect(() => {
    if (atBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [data]);
  return <section aria-label={t("tasks.conversation")} style={{ height: "100%", display: "flex", flexDirection: "column", color: "var(--text)" }}>
    <header style={{ padding: 12, borderBottom: "1px solid var(--border)", display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
      <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <strong>{data?.task.title ?? t("tasks.conversation")}</strong>
        {data && <div role="status" style={{ fontSize: 12, marginTop: 4, color: "var(--text-muted)" }}>{error ? t("tasks.unknown") : t(`tasks.${data.task.status}`)}</div>}
      </div>
      <button type="button" disabled={busy} onClick={() => refresh.current()} style={{ flexShrink: 0, border: "1px solid var(--border)", borderRadius: 5, padding: "5px 10px", background: "var(--bg-panel)", color: "var(--text)" }}>{t(busy ? "tasks.loading" : "tasks.refresh")}</button>
    </header>
    {error && <div role="alert" style={{ padding: 12, color: "var(--text-muted)", fontSize: 12 }}>{t(error)}</div>}
    <div ref={scroll} onScroll={() => { const el = scroll.current; if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }} style={{ flex: 1, overflow: "auto", padding: 12, minHeight: 0 }}>
      {data?.task.detail && <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{data.task.detail === "details_unavailable" ? t("tasks.noDetails") : data.task.detail}</p>}
      {data?.truncated && <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("tasks.truncated")}</p>}
      {data && !data.messages.length && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>{t(data.available ? "tasks.noMessages" : "tasks.noTranscript")}</p>}
      {data?.messages.map((message, index) => <article key={index} style={{ marginBottom: 14, padding: 10, borderRadius: 6, background: "var(--bg-panel)", border: "1px solid var(--border)" }}>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>{t(`tasks.role.${message.role}`)}</div>
        <pre style={{ fontFamily: message.role === "tool" ? "var(--font-mono)" : "inherit", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13, lineHeight: 1.6, margin: 0 }}>{message.text}</pre>
      </article>)}
    </div>
  </section>;
}
