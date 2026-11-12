"use client";

import { useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { createAttachmentId } from "@/lib/attachment-id";
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
  const label = zh ? "查看图片" : "View image";
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
      const name = `chat-image-${createAttachmentId()}.${extension}`;
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
    {canOpen ? <button
      type="button"
      disabled={busy}
      aria-label={label}
      aria-busy={busy}
      onClick={() => void open()}
      style={{ display: "block", padding: 0, border: 0, background: "transparent", maxWidth: "100%", cursor: busy ? "wait" : "zoom-in" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageSrc} alt={alt} loading="lazy" style={{ ...style, display: "block" }} />
    </button> : (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={imageSrc} alt={alt} loading="lazy" style={style} />
    )}
    {error && <span role="alert" style={{ color: "var(--text-muted)", fontSize: 12 }}>{error}</span>}
  </span>;
}
