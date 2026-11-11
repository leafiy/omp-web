"use client";

import type { CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  mobile: boolean;
  streaming: boolean;
  sendEnabled: boolean;
  steerEnabled: boolean;
  followUpEnabled: boolean;
  attachmentBusy: boolean;
  steerHint: string;
  followUpHint: string;
  onSend: () => void | Promise<void>;
  onSteer?: () => void;
  onFollowUp?: () => void;
  onAbort: () => void;
}

/** One action group; mobile places it below the full-width editor, never beside it. */
export function ComposerActions({ mobile, streaming, sendEnabled, steerEnabled, followUpEnabled, attachmentBusy, steerHint, followUpHint, onSend, onSteer, onFollowUp, onAbort }: Props) {
  const { t } = useI18n();
  const common: CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: mobile ? 0 : 5,
    flexShrink: 0, width: mobile ? 44 : undefined, minWidth: 44, height: 44,
    padding: mobile ? 0 : "10px 16px", borderRadius: 8,
    fontSize: 16, fontWeight: 400, lineHeight: 1.5, letterSpacing: "normal",
    transition: "background 0.15s, box-shadow 0.15s",
  };
  const size = 18;
  return <div data-composer-actions style={{ display: "flex", alignItems: "center", gap: mobile ? 4 : 6, flexShrink: 0, alignSelf: mobile ? "center" : "flex-end" }}>
    {streaming ? <>
      {onSteer && <button type="button" onClick={onSteer} disabled={!steerEnabled} aria-label={t("chat.steer")} title={steerHint} style={{ ...common,
        background: steerEnabled ? "rgba(234,179,8,0.12)" : "none", border: "1px solid rgba(234,179,8,0.35)",
        color: steerEnabled ? "rgba(180,130,0,1)" : "var(--text-dim)", cursor: steerEnabled ? "pointer" : "not-allowed",
      }}>
        <svg width={size} height={size} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 1 L9 5 L5 9" /><line x1="1" y1="5" x2="9" y2="5" /></svg>
        {!mobile && t("chat.steer")}
      </button>}
      {onFollowUp && <button type="button" onClick={onFollowUp} disabled={!followUpEnabled} aria-label={t("chat.followUp")} title={followUpHint} style={{ ...common,
        background: followUpEnabled ? "rgba(129,140,248,0.12)" : "none", border: "1px solid rgba(129,140,248,0.35)",
        color: followUpEnabled ? "rgba(99,102,241,1)" : "var(--text-dim)", cursor: followUpEnabled ? "pointer" : "not-allowed",
      }}>
        <svg width={size} height={size} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="5" y1="1" x2="5" y2="6" /><polyline points="2.5 3.5 5 1 7.5 3.5" /><line x1="2" y1="9" x2="8" y2="9" /></svg>
        {!mobile && t("chat.followUp")}
      </button>}
      {mobile && <button type="button" data-composer-stop onClick={onAbort} aria-label={t("chat.stopAgent")} title={t("chat.stopAgent")} style={{ ...common, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444", cursor: "pointer" }}>
        <svg width={18} height={18} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" rx="1.5" /></svg>
      </button>}
    </> : <button type="button" className="sf-send-btn" onClick={onSend} disabled={attachmentBusy || !sendEnabled} aria-label={t("chat.send")} title={t("chat.send")} style={{ ...common,
      padding: mobile ? 0 : "10px 20px", opacity: attachmentBusy ? .5 : 1,
      background: sendEnabled ? "var(--accent)" : "var(--bg-panel)", border: "none",
      color: sendEnabled ? "#fff" : "var(--text-dim)", cursor: sendEnabled ? "pointer" : "not-allowed",
      boxShadow: sendEnabled ? "0 1px 3px rgba(37,99,235,0.25)" : "none",
    }}>
      <svg width={18} height={18} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="2" y1="7" x2="11" y2="7" /><polyline points="7.5 3 12 7 7.5 11" /></svg>
      {!mobile && t("chat.send")}
    </button>}
  </div>;
}
