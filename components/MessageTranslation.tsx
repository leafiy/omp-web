"use client";

import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { useTranslateAvailable } from "@/hooks/useTranslate";
import { cachedTranslation, rememberTranslation, requestTranslation } from "@/lib/translate-client";
import { readMessageTranslation, subscribeMessageTranslations, translationSourceKey, writeMessageTranslation, type MessageTranslationState } from "@/lib/message-translations";
import { TRANSLATE_DIRECTIONS, type TranslateDirection } from "@/lib/translate-text";

export interface MessageTranslation {
  available: boolean;
  state: MessageTranslationState | null;
  toggle: (direction: TranslateDirection) => void;
  close: () => void;
}

// Requests belong to the message, not to its view: one still running when the
// conversation is switched away finishes and is there on return.
const jobs = new Map<string, AbortController>();

function stopJob(scope: string, key: string): void {
  const id = `${scope}\0${key}`;
  jobs.get(id)?.abort();
  jobs.delete(id);
}

function startTranslation(scope: string, key: string, source: string, direction: TranslateDirection, persist: boolean): void {
  stopJob(scope, key);
  const cached = cachedTranslation(direction, source);
  if (cached !== undefined) {
    writeMessageTranslation(scope, key, { direction, status: "done", text: cached }, persist);
    return;
  }
  const id = `${scope}\0${key}`;
  const job = new AbortController();
  jobs.set(id, job);
  writeMessageTranslation(scope, key, { direction, status: "loading" }, persist);
  requestTranslation([source], direction, job.signal).then(([text]) => {
    rememberTranslation(direction, source, text);
    if (!job.signal.aborted) writeMessageTranslation(scope, key, { direction, status: "done", text }, persist);
  }, (error) => {
    if (!job.signal.aborted) writeMessageTranslation(scope, key, { direction, status: "error", error: error instanceof Error ? error.message : String(error) }, persist);
  }).finally(() => {
    if (jobs.get(id) === job) jobs.delete(id);
  });
}

function stopTranslation(scope: string, key: string, persist: boolean): void {
  stopJob(scope, key);
  writeMessageTranslation(scope, key, null, persist);
}

/**
 * Per-message ZH⇄EN translation; clicking the active direction again hides it.
 * In a conversation it stays shown, keyed by session and message text, across
 * conversation switches, folded turns and reloads (`lib/message-translations.ts`);
 * closing it forgets it. Without a session it ends with this view.
 */
export function useMessageTranslation(source: string, sessionId?: string): MessageTranslation {
  const configured = useTranslateAvailable();
  const viewId = useId();
  const persist = !!sessionId;
  const scope = sessionId ? `session:${sessionId}` : `view:${viewId}`;
  // A changed message has another key, so it never shows an old translation.
  const key = useMemo(() => source ? translationSourceKey(source) : "", [source]);
  const state = useSyncExternalStore(
    subscribeMessageTranslations,
    () => key ? readMessageTranslation(scope, key) : null,
    () => null,
  );

  useEffect(() => {
    if (persist || !key) return;
    return () => stopTranslation(scope, key, false);
  }, [persist, scope, key]);

  const close = () => {
    if (!key) return;
    // A reopened result comes back without a new request.
    if (state?.status === "done") rememberTranslation(state.direction, source, state.text);
    stopTranslation(scope, key, persist);
  };

  const toggle = (direction: TranslateDirection) => {
    if (!key) return;
    if (state?.direction === direction && state.status !== "error") { close(); return; }
    startTranslation(scope, key, source, direction, persist);
  };

  return { available: configured && source.trim().length > 0, state, toggle, close };
}

const footerButton: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 4,
  padding: "3px 8px", height: 22,
  background: "none", border: "none", borderRadius: 5,
  cursor: "pointer", fontSize: 11, fontWeight: 400,
  whiteSpace: "nowrap", transition: "opacity 0.12s, color 0.12s",
};

function TranslateIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" />
      <path d="m22 22-5-10-5 10" /><path d="M14 18h6" />
    </svg>
  );
}

/** ZH→EN / EN→ZH footer buttons; renders nothing when translation is not configured. */
export function TranslateButtons({ translation, visible = true }: { translation: MessageTranslation; visible?: boolean }) {
  const { t } = useI18n();
  if (!translation.available) return null;
  return <>
    {TRANSLATE_DIRECTIONS.map((direction) => {
      const active = translation.state?.direction === direction;
      const shown = visible || active;
      const color = active ? "var(--accent)" : "var(--text-dim)";
      return (
        <button
          key={direction}
          type="button"
          aria-pressed={active}
          onClick={() => translation.toggle(direction)}
          title={t(`translate.${direction}Title`)}
          style={{ ...footerButton, color, opacity: shown ? 1 : 0, pointerEvents: shown ? "auto" : "none" }}
          onMouseEnter={(event) => { event.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = color; }}
        >
          <TranslateIcon />
          {t(`translate.${direction}`)}
        </button>
      );
    })}
  </>;
}

/** The translation shown under a message: loading, error or rendered Markdown. */
export function TranslationPanel({ translation, cwd, onOpenFile, maxWidth }: {
  translation: MessageTranslation;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  maxWidth?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const state = translation.state;
  if (!state) return null;
  const done = state.status === "done" ? state.text : null;
  return (
    <div
      aria-live="polite"
      style={{
        marginTop: 6, maxWidth: maxWidth ?? "100%", minWidth: 0, boxSizing: "border-box",
        padding: "6px 12px 8px", border: "1px solid var(--border)", borderRadius: 8,
        background: "var(--bg-panel)", color: "var(--text)", wordBreak: "break-word",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-dim)", marginBottom: state.status === "done" ? 4 : 0 }}>
        <TranslateIcon />
        <span>{t("translate.panelTitle", { direction: t(`translate.${state.direction}`) })}</span>
        <span style={{ flex: 1 }} />
        {done !== null && (
          <button
            type="button"
            onClick={() => { void copyText(done).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
            title={t("i18n.copy")}
            style={{ ...footerButton, padding: "2px 6px", height: 20, color: copied ? "var(--accent)" : "var(--text-dim)" }}
          >
            {copied ? t("i18n.copied") : t("i18n.copy")}
          </button>
        )}
        <button
          type="button"
          onClick={translation.close}
          title={t("translate.close")}
          aria-label={t("translate.close")}
          style={{ ...footerButton, padding: "2px 6px", height: 20, color: "var(--text-dim)" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {state.status === "loading" && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("translate.translating")}</div>}
      {state.status === "error" && (
        <div role="alert" style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{state.error}</div>
      )}
      {done !== null && <MarkdownBody className="markdown-reading" cwd={cwd} onOpenFile={onOpenFile}>{done}</MarkdownBody>}
    </div>
  );
}
