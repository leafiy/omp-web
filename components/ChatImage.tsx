"use client";

import { useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { resolveLocalFileHref } from "@/lib/file-links";

/** Preview conversation images directly. Viewing must never write project files. */
export function ChatImage({ src, alt = "", cwd, onOpenFile, style }: {
  src: string; alt?: string; cwd?: string; onOpenFile?: (path: string) => void; style?: CSSProperties;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [previewOpen, setPreviewOpen] = useState(false);
  const localPath = resolveLocalFileHref(src, cwd);
  const imageSrc = localPath ? `/api/files/${encodeFilePathForApi(localPath)}?type=read` : src;
  const open = () => {
    if (localPath && onOpenFile) onOpenFile(localPath);
    else setPreviewOpen(true);
  };
  return <>
    <button
      type="button"
      aria-label={zh ? "查看图片" : "View image"}
      onClick={open}
      style={{ display: "inline-block", padding: 0, border: 0, background: "transparent", maxWidth: "100%", cursor: "zoom-in" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageSrc} alt={alt} loading="lazy" style={{ ...style, display: "block" }} />
    </button>
    {previewOpen && createPortal(<dialog
      ref={(dialog) => { if (dialog && !dialog.open) dialog.showModal(); }}
      aria-label={zh ? "图片预览" : "Image preview"}
      onClose={() => setPreviewOpen(false)}
      onClick={(event) => { if (event.target === event.currentTarget) setPreviewOpen(false); }}
      style={{ margin: "auto", maxWidth: "96vw", maxHeight: "96dvh", padding: 12, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", color: "var(--text)" }}
    >
      <button type="button" autoFocus onClick={() => setPreviewOpen(false)} style={{ display: "block", marginLeft: "auto", marginBottom: 8, cursor: "pointer" }}>{zh ? "关闭" : "Close"}</button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageSrc} alt={alt} style={{ display: "block", maxWidth: "90vw", maxHeight: "82dvh", objectFit: "contain" }} />
    </dialog>, document.body)}
  </>;
}
