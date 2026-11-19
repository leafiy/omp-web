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
          ? "默认开启，记住此浏览器的选择。上翻查看历史时暂停跟随，继续翻阅会重新计时。手动滚到底部立即恢复；否则在最后一次滚动 1 分钟后恢复。只有新消息或流式更新才会带动滚动。关闭后，新消息不会改变阅读位置。"
          : "On by default, remembered in this browser. Scrolling through history pauses following. Scroll back to the bottom to resume immediately, or wait one minute after your last scroll. Only new messages or streaming updates move the view. When off, new messages do not move your reading position."}
      </div>
    </section>
  );
}
