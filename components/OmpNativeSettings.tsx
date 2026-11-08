"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { engineLabel, type AgentEngine } from "@/lib/engine";
import { ToolUpdateControl } from "./ToolUpdateControl";
import { WebAccountSettings } from "./WebAccountSettings";

/** One settings entry for every tool; agent credential editors remain disabled. */
export function OmpNativeSettings({ engine, onClose }: { engine: AgentEngine; onClose: () => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]') || [])
        .filter((element) => element.getClientRects().length > 0);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [onClose]);
  return (
    <div onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.45)", display: "grid", placeItems: "center", padding: 16 }}>
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="engine-settings-title" style={{ width: "100%", maxWidth: 620, maxHeight: "90dvh", overflow: "auto", padding: 20, borderRadius: 12, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", lineHeight: 1.6 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 id="engine-settings-title" style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{zh ? "设置" : "Settings"}</h2>
          <button type="button" autoFocus onClick={onClose} style={{ padding: "5px 12px", background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer" }}>{zh ? "关闭" : "Close"}</button>
        </div>
        <div style={{ marginTop: 12, fontSize: 13, color: "var(--text-muted)" }}>{engineLabel(engine)}</div>
        <WebAccountSettings />
        <ToolUpdateControl zh={zh} />
      </section>
    </div>
  );
}
