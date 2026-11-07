"use client";

import { useId, useLayoutEffect, useRef } from "react";

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A local confirmation, not a modal: no backdrop, focus trap or document handlers. */
export function InlineConfirmation({ title, message, confirmLabel, cancelLabel, confirmDisabled = false, onConfirm, onCancel }: Props) {
  const titleId = useId(), messageId = useId();
  const root = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const answered = useRef(false);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const region = root.current;
    // Default focus is cancellation, never the destructive action.
    cancel.current?.focus();
    return () => {
      if (region?.contains(document.activeElement) && previous?.isConnected) previous.focus();
    };
  }, []);
  function answer(accepted: boolean) {
    if (answered.current || accepted && confirmDisabled) return;
    answered.current = true;
    if (accepted) onConfirm(); else onCancel();
  }
  const buttonStyle = { padding: "7px 12px", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", background: "var(--bg)", fontSize: 13, cursor: "pointer" };
  return <div ref={root} role="group" aria-labelledby={titleId} aria-describedby={messageId} data-inline-confirmation
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); answer(false); } }}
    style={{ border: "1px solid var(--accent)", borderRadius: 8, padding: 12, margin: "10px 0", background: "var(--bg-panel)", color: "var(--text)", overflowWrap: "anywhere", maxHeight: "45dvh", overflowY: "auto", flexShrink: 0 }}>
    <h4 id={titleId} style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 600 }}>{title}</h4>
    <p id={messageId} role="status" style={{ margin: 0, fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--text-muted)" }}>{message}</p>
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
      <button ref={cancel} type="button" onClick={() => answer(false)} style={buttonStyle}>{cancelLabel}</button>
      <button type="button" disabled={confirmDisabled} onClick={() => answer(true)} style={{ ...buttonStyle, background: "var(--bg-selected)", borderColor: "var(--accent)", fontWeight: 600, opacity: confirmDisabled ? .5 : 1, cursor: confirmDisabled ? "not-allowed" : "pointer" }}>{confirmLabel}</button>
    </div>
  </div>;
}
