"use client";

import type { AttachedFile } from "@/lib/file-attachments";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";
import { getFileIcon } from "./FileIcons";

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Shared by the composer and transcript; removing a card never deletes a persisted file. */
export function FileAttachment({ file, onRemove, onOpenFile }: {
  file: AttachedFile;
  onRemove?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div data-file-attachment style={{ display: "inline-flex", alignItems: "center", gap: 8, maxWidth: "100%", minWidth: 0, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", verticalAlign: "middle" }}>
      <a
        href={`/api/files/${encodeFilePathForApi(file.path)}?type=download`}
        download={file.name}
        onClick={onOpenFile ? (event) => { event.preventDefault(); onOpenFile(file.path); } : undefined}
        title={t("chat.openFileAttachment", { name: file.name })}
        style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, color: "var(--text)", textDecoration: "none" }}
      >
        <span style={{ display: "flex", flexShrink: 0 }}>{getFileIcon(file.name, 24)}</span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{file.name}</span>
          <span style={{ display: "block", color: "var(--text-muted)", fontSize: 11 }}>{fileSize(file.size)}</span>
        </span>
      </a>
      {onRemove && <button
        type="button"
        onClick={onRemove}
        title={t("chat.removeFileAttachment", { name: file.name })}
        aria-label={t("chat.removeFileAttachment", { name: file.name })}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, width: 24, height: 24, border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m2 2 8 8M10 2l-8 8" /></svg>
      </button>}
    </div>
  );
}
