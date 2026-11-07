"use client";
import { useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AgentMessage } from "@/lib/types";

/** Expanded payload stays local to this view; it is not added to the history LRU. */
export function DeferredHistoryMessage({ message, children }: { message: AgentMessage; children: (message: AgentMessage) => ReactNode }) {
  const { locale } = useI18n(), zh = locale === "zh-CN";
  const [loaded, setLoaded] = useState<AgentMessage | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  async function load() {
    if (busy || !message.historySessionId || !message.historyEntryId) return;
    setBusy(true); setError(false);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(message.historySessionId)}/entries/${encodeURIComponent(message.historyEntryId)}/message`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!data.message || data.message.role !== message.role || data.message.historyDeferred) throw new Error();
      setLoaded(data.message);
    } catch { setError(true); } finally { setBusy(false); }
  }
  if (loaded) return children(loaded);
  return <div style={{ padding: 12, margin: "8px 0", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-muted)", fontSize: 13 }}>
    <p>{zh ? "图片或大块历史内容已按需加载，避免拖慢会话切换。" : "Images or large history content are loaded on demand to keep switching fast."}</p>
    {error && <p role="alert">{zh ? "读取失败，请刷新会话或重试。" : "Could not load this message. Refresh the chat or retry."}</p>}
    <button type="button" disabled={busy} onClick={() => void load()} style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", background: "var(--bg-panel)" }}>{busy ? (zh ? "读取中…" : "Loading…") : (zh ? "加载完整内容" : "Load full content")}</button>
  </div>;
}
