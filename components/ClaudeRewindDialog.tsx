"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { RewindMode, RewindPreview } from "@/hooks/useAgentSession";

function relative(path: string, cwd?: string): string {
  if (cwd && path.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`)) return path.slice(cwd.length).replace(/^\//, "");
  return path;
}

/**
 * Claude Code Rewind (the terminal's /rewind): restore code from native
 * checkpoints and/or the conversation to before the chosen user message.
 * The preview is a dry run; nothing changes until an option is chosen.
 */
export function ClaudeRewindDialog({ entryId, cwd, onPreview, onRewind, onClose }: {
  entryId: string;
  cwd?: string;
  onPreview: (entryId: string) => Promise<RewindPreview>;
  onRewind: (entryId: string, mode: RewindMode) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setPreview(null);
    setError(null);
    onPreview(entryId)
      .then((result) => { if (current) setPreview(result); })
      .catch((failure) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { current = false; };
  }, [entryId, onPreview]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const run = async (mode: RewindMode) => {
    setBusy(true);
    const ok = await onRewind(entryId, mode);
    setBusy(false);
    if (ok) onClose();
  };

  const files = preview?.files;
  const conversation = preview?.conversation;
  const changed = files?.filesChanged ?? [];
  const hasFileChanges = Boolean(files?.canRewind && (changed.length || files.insertions || files.deletions));
  const options: Array<{ mode: RewindMode; label: string; enabled: boolean }> = [
    { mode: "both", label: t("rewind.both"), enabled: Boolean(conversation?.canRewind && hasFileChanges) },
    { mode: "conversation", label: t("rewind.conversation"), enabled: Boolean(conversation?.canRewind) },
    { mode: "files", label: t("rewind.files"), enabled: hasFileChanges },
  ];

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 90, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "rgba(0,0,0,0.18)" }}>
      <div role="dialog" aria-modal="true" aria-label={t("rewind.title")} style={{ width: "min(560px, 100%)", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", boxShadow: "0 20px 60px rgba(0,0,0,0.28)", overflow: "hidden" }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{t("rewind.title")}</div>
          <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 12.5, lineHeight: 1.55 }}>{t("rewind.description")}</div>
        </div>
        <div style={{ padding: 14, display: "grid", gap: 10, fontSize: 13, color: "var(--text-muted)", maxHeight: "50vh", overflowY: "auto" }}>
          {error && <div role="alert" style={{ color: "#ef4444", overflowWrap: "anywhere" }}>{error}</div>}
          {!preview && !error && <div role="status">{t("rewind.loading")}</div>}
          {conversation && (
            <div>
              <div style={{ color: "var(--text)", fontWeight: 600 }}>{t("rewind.conversationHeading")}</div>
              <div>{conversation.canRewind ? t("rewind.messagesRemoved", { count: conversation.messagesRemoved ?? 0 }) : conversation.error ?? t("rewind.unavailable")}</div>
            </div>
          )}
          {files && (
            <div>
              <div style={{ color: "var(--text)", fontWeight: 600 }}>{t("rewind.filesHeading")}</div>
              {!files.canRewind
                ? <div style={{ overflowWrap: "anywhere" }}>{files.error ?? t("rewind.filesUnavailable")}</div>
                : !hasFileChanges
                  ? <div>{t("rewind.noFileChanges")}</div>
                  : <>
                    <div>{t("rewind.fileStats", { count: changed.length, insertions: files.insertions, deletions: files.deletions })}</div>
                    <ul style={{ margin: "6px 0 0", padding: "0 0 0 16px", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.6 }}>
                      {changed.slice(0, 30).map((path) => <li key={path} style={{ overflowWrap: "anywhere" }}>{relative(path, cwd)}</li>)}
                      {changed.length > 30 && <li>{t("rewind.moreFiles", { count: changed.length - 30 })}</li>}
                    </ul>
                  </>}
            </div>
          )}
          <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{t("rewind.note")}</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button type="button" onClick={onClose} disabled={busy} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: busy ? "default" : "pointer" }}>{t("chat.cancel")}</button>
          {options.map((option) => (
            <button
              key={option.mode}
              type="button"
              disabled={busy || !option.enabled}
              onClick={() => { void run(option.mode); }}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--accent)", background: option.mode === "both" ? "var(--accent)" : "var(--bg)", color: option.mode === "both" ? "#fff" : "var(--accent)", cursor: busy || !option.enabled ? "not-allowed" : "pointer", opacity: busy || !option.enabled ? 0.45 : 1 }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
