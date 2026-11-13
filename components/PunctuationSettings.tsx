"use client";

import { useSyncExternalStore } from "react";
import { useI18n } from "@/hooks/useI18n";
import { readPunctuationConversion, subscribePunctuationConversion, writePunctuationConversion } from "@/lib/punctuation-conversion";

export function PunctuationSettings() {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const enabled = useSyncExternalStore(subscribePunctuationConversion, readPunctuationConversion, () => true);
  return (
    <section style={{ marginTop: 16, padding: 14, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)" }}>
      <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
        {zh ? "标调符号转换" : "Punctuation conversion"}
        <input type="checkbox" role="switch" checked={enabled} onChange={(event) => writePunctuationConversion(event.target.checked)} style={{ accentColor: "var(--accent)", width: 18, height: 18 }} />
      </label>
      <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}>
        {zh
          ? "默认开启，记住此浏览器的选择。发送、插话和追加前，将全角字符及中文标点转换为半角英文形式，包含代码和长粘贴内容。无英文对应的符号保留；命令及可能变成命令的开头符号保持原样。不会修改已上传文件或历史消息。"
          : "On by default, remembered in this browser. Convert fullwidth characters and Chinese punctuation before sending, steering or following up, including code and long pastes. Symbols without an English equivalent, commands and command-like leading symbols stay unchanged. Uploaded files and existing history are not modified."}
      </div>
    </section>
  );
}
