"use client";

import { useSyncExternalStore } from "react";
import { useI18n } from "@/hooks/useI18n";
import { readChatAutoScroll, subscribeChatAutoScroll, writeChatAutoScroll } from "@/lib/chat-auto-scroll";

export function ChatDisplaySettings() {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const enabled = useSyncExternalStore(subscribeChatAutoScroll, readChatAutoScroll, () => true);
  return (
    <section style={{ marginTop: 16, padding: 14, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)" }}>
      <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
        {zh ? "新消息自动滚动" : "Auto-scroll to new messages"}
        <input type="checkbox" role="switch" checked={enabled} onChange={(event) => writeChatAutoScroll(event.target.checked)} style={{ accentColor: "var(--accent)", width: 18, height: 18 }} />
      </label>
      <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}>
        {zh
          ? "默认开启，记住此浏览器的选择。新消息和流式回复自动跟随到底部；手动滚动后暂停 1 分钟，再次滚动重新计时。到期只解除暂停，后续有新内容才跟随，不会打断静态历史阅读。关闭后，新消息不会改变阅读位置。"
          : "On by default, remembered in this browser. Follow new messages and streaming replies. Manual scrolling pauses following for one minute; scrolling again restarts the timer. Expiry only allows subsequent new content to follow—it never moves you away from static history. When off, new messages do not move your reading position."}
      </div>
    </section>
  );
}
