"use client";

import { useEffect, useRef, useState } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { useTranslateAvailable } from "@/hooks/useTranslate";
import { cachedTranslation, rememberTranslation, requestTranslation } from "@/lib/translate-client";
import { TRANSLATE_DIRECTIONS, type TranslateDirection } from "@/lib/translate-text";

type TranslationState =
  | { direction: TranslateDirection; status: "loading" }
  | { direction: TranslateDirection; status: "done"; text: string }
  | { direction: TranslateDirection; status: "error"; error: string };

export interface MessageTranslation {
  available: boolean;
  state: TranslationState | null;
  toggle: (direction: TranslateDirection) => void;
  close: () => void;
}

/** Per-message ZH⇄EN translation; clicking the active direction again hides it. */
export function useMessageTranslation(source: string): MessageTranslation {
  const configured = useTranslateAvailable();
  // Tagged with its source text: a changed message never shows an old translation.
  const [entry, setEntry] = useState<{ source: string; state: TranslationState } | null>(null);
  const jobRef = useRef<AbortController | null>(null);
  useEffect(() => () => jobRef.current?.abort(), []);
  const state = entry?.source === source ? entry.state : null;

  const close = () => {
    jobRef.current?.abort();
    jobRef.current = null;
    setEntry(null);
  };

  const toggle = (direction: TranslateDirection) => {
    if (state?.direction === direction && state.status !== "error") { close(); return; }
    jobRef.current?.abort();
    jobRef.current = null;
    const cached = cachedTranslation(direction, source);
    if (cached !== undefined) { setEntry({ source, state: { direction, status: "done", text: cached } }); return; }
    const job = new AbortController();
    jobRef.current = job;
    setEntry({ source, state: { direction, status: "loading" } });
    requestTranslation([source], direction, job.signal).then(([text]) => {
      rememberTranslation(direction, source, text);
      if (!job.signal.aborted) setEntry({ source, state: { direction, status: "done", text } });
    }, (error) => {
      if (!job.signal.aborted) setEntry({ source, state: { direction, status: "error", error: error instanceof Error ? error.message : String(error) } });
    }).finally(() => {
      if (jobRef.current === job) jobRef.current = null;
    });
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
