"use client";

import { useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { resolveLocalFileHref } from "@/lib/file-links";
import { MAX_UPLOAD_FILE_BYTES } from "@/lib/file-upload-limits";

/** Inline native images have no path. Materialize them only on an explicit click. */
export function ChatImage({ src, alt = "", cwd, onOpenFile, style }: {
  src: string; alt?: string; cwd?: string; onOpenFile?: (path: string) => void; style?: CSSProperties;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef<{ src: string; cwd: string; path: string } | null>(null);
  const inFlight = useRef(false);
  const localPath = resolveLocalFileHref(src, cwd);
  const inline = /^data:image\/(png|jpeg|gif|webp);base64,/i.test(src);
  const canOpen = !!onOpenFile && (!!localPath || (inline && !!cwd));
  const label = localPath ? (zh ? "在文件浏览器中打开" : "Open in file browser")
    : (zh ? "保存并在文件浏览器中打开" : "Save and open in file browser");
  const open = async () => {
    if (!onOpenFile || inFlight.current) return;
    if (localPath) { onOpenFile(localPath); return; }
    if (!inline || !cwd) return;
    if (saved.current?.src === src && saved.current.cwd === cwd) {
      onOpenFile(saved.current.path);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // Do not fetch remote URLs server-side or register new filesystem roots.
      if (src.length > MAX_UPLOAD_FILE_BYTES * 4 / 3 + 128) throw new Error(zh ? "图片超过上传限制" : "Image exceeds upload limit");
      const blob = await (await fetch(src)).blob();
      const extension = blob.type.split("/")[1] === "jpeg" ? "jpg" : blob.type.split("/")[1];
      const name = `chat-image-${crypto.randomUUID()}.${extension}`;
      const form = new FormData();
      form.append("files", blob, name);
      const response = await fetch(`/api/files/${encodeFilePathForApi(cwd)}?type=upload&conflict=error`, { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok || !result.uploaded?.includes(name)) {
        throw new Error(result.error ?? result.errors?.[0]?.error ?? (zh ? "保存图片失败" : "Failed to save image"));
      }
      const path = `${cwd.replace(/\/$/, "")}/${name}`;
      saved.current = { src, cwd, path };
      window.dispatchEvent(new Event("omp-web:files-changed"));
      onOpenFile(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const imageSrc = localPath ? `/api/files/${encodeFilePathForApi(localPath)}?type=read` : src;
  return <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, maxWidth: "100%" }}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={imageSrc} alt={alt} loading="lazy" style={style} />
    {canOpen && <button type="button" disabled={busy} onClick={() => void open()} style={{ color: "var(--accent)", fontSize: 12, cursor: busy ? "wait" : "pointer", textAlign: "left" }}>{busy ? (zh ? "正在保存…" : "Saving…") : label}</button>}
    {error && <span role="alert" style={{ color: "var(--text-muted)", fontSize: 12 }}>{error}</span>}
  </span>;
}
