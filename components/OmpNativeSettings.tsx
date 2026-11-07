"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { engineLabel, type AgentEngine } from "@/lib/engine";
import { ToolUpdateControl } from "./ToolUpdateControl";

/** One settings entry for every tool; credential editors remain disabled. */
export function OmpNativeSettings({ engine, onClose }: { engine: AgentEngine; onClose: () => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [tabindex="0"]') || [])
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
        <p style={{ margin: "12px 0 4px", fontSize: 13 }}>{zh ? "当前对话使用：" : "Current chat: "}<strong>{engineLabel(engine)}</strong></p>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}>{engine === "claude"
          ? (zh ? "直接使用本机 Claude Code 的登录和配置。未登录时，请在终端运行 claude。" : "Uses this machine's native Claude Code login and configuration. Run claude in a terminal to sign in.")
          : engine === "codex"
            ? (zh ? "直接使用本机 Codex 的登录。模型在输入框旁选择；未登录时，在终端运行 codex login。" : "Uses your local Codex login. Choose a model beside the input; run codex login in a terminal if needed.")
            : (zh ? "想换模型？在聊天输入框旁的模型菜单里选。" : "To change models, use the model menu beside the chat input.")}</p>
        <ToolUpdateControl zh={zh} />
        <details style={{ marginTop: 18, paddingTop: 12, borderTop: "1px solid var(--border)", fontSize: 13, color: "var(--text-muted)" }}>
          <summary style={{ cursor: "pointer" }}>{zh ? "登录、技能和插件" : "Login, skills and plugins"}</summary>
          <p>{zh ? "这些功能目前在对应软件的终端里管理，网页暂不提供编辑。已有登录不需要重新登录。" : "Manage these in each tool's terminal for now. Existing valid logins do not need to be repeated."}</p>
          <p>{zh ? "网页只是访问界面，不自带模型设置、密钥或登录。各工具使用这台机器上自己的配置；更新按钮只升级软件。" : "This is an access interface, not a model configuration or credential store. Each native tool owns its configuration; update buttons only upgrade software."}</p>
        </details>
      </section>
    </div>
  );
}
